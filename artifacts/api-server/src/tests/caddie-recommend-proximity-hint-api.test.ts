/**
 * Task #2033 — end-to-end coverage for the AI Caddie API's per-club
 * proximity coaching hint.
 *
 * Task #1642 added unit tests around `recommend()` proving it appends
 * the hint when the recommended club has a known >= 3 ft gap. Those
 * tests stop at the engine boundary, so a future refactor of
 * `/portal/caddie/recommend` (e.g. how shots are fetched, how
 * `computeProximityCoachingTips` is invoked, how the resulting map is
 * threaded back into `recommend()`) could silently drop the hint from
 * the API response while the engine-level unit tests stay green.
 *
 * These tests exercise the *full* request path:
 *
 *   1. Sign in as a player.
 *   2. Seed tracked approach shots that produce a known per-club
 *      proximity gap vs the static tour benchmark.
 *   3. Call GET /portal/caddie/recommend with a distance that forces
 *      the engine to recommend that club.
 *   4. Assert the response `rationale` array contains the expected
 *      coaching-hint string.
 *
 * Two negative cases prove the absence of the hint is also verified
 * through the API:
 *
 *   - the recommended club has no proximity gap at all
 *   - the recommended club is *not* the one with the gap (the gap
 *     belongs to a longer iron the engine doesn't pick)
 *
 * Uses the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  playersTable,
  tournamentsTable,
  organizationsTable,
  coursesTable,
  shotsTable,
  caddieRecommendationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;
let testUser: TestUser;

beforeAll(async () => {
  const tag = uid("caddieHintApi");

  const [org] = await db.insert(organizationsTable).values({
    name: `CaddieHintApi_${tag}`,
    slug: `caddie-hint-api-${tag}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Caddie Hint API Course",
    slug: `caddie-hint-api-course-${tag}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Caddie Hint API Tournament ${tag}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: "Caddie Hint API Tester",
    role: "player",
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;
  testUser = { id: u.id, username: tag, role: "player" };

  const [p] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    userId: testUserId,
    firstName: "Caddie",
    lastName: "HintTester",
  }).returning({ id: playersTable.id });
  testPlayerId = p.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.playerId, testPlayerId));
  await db.delete(caddieRecommendationsTable).where(eq(caddieRecommendationsTable.userId, testUserId));
  await db.delete(playersTable).where(eq(playersTable.id, testPlayerId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  // Clear shots and any persisted recommendations so each test starts from a
  // clean slate — the route reads *all* of the player's tracked shots when
  // computing the per-club proximity gap, so leftovers from a sibling test
  // would contaminate the gap calculation.
  await db.delete(shotsTable).where(eq(shotsTable.playerId, testPlayerId));
  await db.delete(caddieRecommendationsTable).where(eq(caddieRecommendationsTable.userId, testUserId));
});

/**
 * Insert `count` (approach + putt) pairs for the same club. Each pair lives
 * on a distinct hole so the per-hole "next-shot proximity" computation pairs
 * the approach with the putt that follows it.
 *
 *   - `carryYards` populates `distanceCarried` on the approach so the
 *     `/caddie/recommend` aggregate query treats this club as known with
 *     `avgCarry = carryYards`.
 *   - `proximityYds` is the putt's `distanceToPin` (in yards). The proximity
 *     module multiplies by 3 to convert to feet, so this directly controls
 *     the player's mean proximity for the club.
 */
async function seedApproachWithPutt(opts: {
  club: string;
  carryYards: number;
  approachFromYds: number;
  proximityYds: number;
  count: number;
  holeOffset: number;
}) {
  // Recent enough to fall inside the 30-day current window the route uses
  // when it computes proximity coaching tips.
  const recordedAt = new Date(Date.now() - 60 * 60 * 1000);
  const rows: Array<typeof shotsTable.$inferInsert> = [];
  for (let i = 0; i < opts.count; i++) {
    const hole = opts.holeOffset + i + 1;
    rows.push({
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      userId: testUserId,
      round: 1,
      holeNumber: hole,
      shotNumber: 1,
      shotType: "approach",
      club: opts.club,
      distanceToPin: String(opts.approachFromYds),
      distanceCarried: String(opts.carryYards),
      recordedAt,
    });
    rows.push({
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      userId: testUserId,
      round: 1,
      holeNumber: hole,
      shotNumber: 2,
      shotType: "putt",
      distanceToPin: String(opts.proximityYds),
      recordedAt: new Date(recordedAt.getTime() + 60_000),
    });
  }
  await db.insert(shotsTable).values(rows);
}

const CADDIE_RECOMMEND_URL = "/api/portal/caddie/recommend";

describe("GET /portal/caddie/recommend — proximity coaching hint (Task #2033)", () => {
  it("appends the per-club coaching hint to the rationale when the recommended club has a >= 3 ft gap vs tour", async () => {
    // Tour 7-iron benchmark = 31 ft. Putts at 13y → 39 ft mean proximity.
    // Gap = 39 − 31 = 8 ft → above the 3 ft threshold, so the engine should
    // append the coaching hint to its rationale.
    //   gapDisplay  = round(8)        = 8
    //   aimLongFt   = max(2, round(8 * 0.6)) = 5
    //   caddieHint  = "you're 8 ft worse with the 7 Iron — aim 5 ft long of pin"
    await seedApproachWithPutt({
      club: "7 Iron",
      carryYards: 150,
      approachFromYds: 150,
      proximityYds: 13,
      count: 4,
      holeOffset: 0,
    });

    const app = createTestApp(testUser);
    const res = await request(app)
      .get(CADDIE_RECOMMEND_URL)
      .query({ distanceYards: 150, persist: "false" })
      .expect(200);

    // Sanity-check the engine actually picked the club we seeded shots for —
    // otherwise the negative assertions below would pass for the wrong reason.
    expect(res.body.recommended?.club).toBe("7 Iron");

    const rationale = res.body.rationale as string[];
    expect(Array.isArray(rationale)).toBe(true);
    expect(rationale).toContain(
      "you're 8 ft worse with the 7 Iron \u2014 aim 5 ft long of pin",
    );
  });

  it("does NOT append a coaching hint when the recommended club has no meaningful gap vs tour", async () => {
    // Tour 7-iron benchmark = 31 ft. Putts at 9y → 27 ft mean proximity.
    // Gap = 27 − 31 = −4 ft → below the 3 ft threshold so no tip is produced
    // for this club, and the engine must NOT add a coaching hint.
    await seedApproachWithPutt({
      club: "7 Iron",
      carryYards: 150,
      approachFromYds: 150,
      proximityYds: 9,
      count: 4,
      holeOffset: 0,
    });

    const app = createTestApp(testUser);
    const res = await request(app)
      .get(CADDIE_RECOMMEND_URL)
      .query({ distanceYards: 150, persist: "false" })
      .expect(200);

    expect(res.body.recommended?.club).toBe("7 Iron");

    const rationale = res.body.rationale as string[];
    expect(Array.isArray(rationale)).toBe(true);
    // No "worse with the 7 Iron" framing and no aim-long-of-pin instruction
    // should appear — both are unique to the proximity coaching hint.
    expect(rationale.some((r) => r.includes("worse with the 7 Iron"))).toBe(false);
    expect(rationale.some((r) => /aim \d+ ft long of pin/.test(r))).toBe(false);
  });

  it("does NOT append a coaching hint when the gap belongs to a club the engine does not recommend", async () => {
    // 7-iron has a real gap (mean 39 ft vs tour 31 ft → 8 ft gap), but we ask
    // the engine for a 130y shot so it picks the 9-iron instead. The
    // 9-iron's mean proximity (8y * 3 = 24 ft) matches its tour benchmark
    // (24 ft) so no tip is produced for the recommended club either way.
    // The 7-iron's hint must NOT leak into the rationale just because the
    // map happens to contain it.
    await seedApproachWithPutt({
      club: "7 Iron",
      carryYards: 150,
      approachFromYds: 150,
      proximityYds: 13,
      count: 4,
      holeOffset: 0,
    });
    await seedApproachWithPutt({
      club: "9 Iron",
      carryYards: 130,
      approachFromYds: 130,
      proximityYds: 8,
      count: 4,
      holeOffset: 4,
    });

    const app = createTestApp(testUser);
    const res = await request(app)
      .get(CADDIE_RECOMMEND_URL)
      .query({ distanceYards: 130, persist: "false" })
      .expect(200);

    // 9-iron's avgCarry (130) sits on the target distance, so the engine
    // must prefer it over the 7-iron's 150y carry.
    expect(res.body.recommended?.club).toBe("9 Iron");

    const rationale = res.body.rationale as string[];
    expect(Array.isArray(rationale)).toBe(true);
    expect(rationale.some((r) => r.includes("worse with the 7 Iron"))).toBe(false);
    expect(rationale.some((r) => r.includes("worse with the 9 Iron"))).toBe(false);
  });
});
