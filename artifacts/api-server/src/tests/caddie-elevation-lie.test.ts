/**
 * Integration tests: elevation + lie inputs on AI Caddie suggestions (Task #488).
 *
 * Covers:
 *   - GET /api/portal/caddie/recommend persists `elevationDeltaYards` and
 *     `lieType` from the query string onto the new `caddie_recommendations`
 *     row so the audit/personalisation signal isn't dropped.
 *   - GET /api/portal/caddie/feedback/summary aggregates `perLie` correctly
 *     (counts, acceptance rate, avg proximities) and groups null lie types
 *     into the "unknown" bucket.
 *
 * Uses the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  caddieRecommendationsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let recommendUserId: number;
let lieUserId: number;

let recommendUser: TestUser;
let lieUser: TestUser;
let recommendApp: ReturnType<typeof createTestApp>;
let lieApp: ReturnType<typeof createTestApp>;

const RECOMMEND_URL = "/api/portal/caddie/recommend";
const SUMMARY_URL = "/api/portal/caddie/feedback/summary";

beforeAll(async () => {
  const stamp = Date.now();

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-elev-recommend-${stamp}`,
    username: `caddie_elev_recommend_${stamp}`,
    email: `caddie_elev_recommend_${stamp}@example.com`,
    displayName: "Caddie Elev Recommend",
    role: "player",
  }).returning({ id: appUsersTable.id });
  recommendUserId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-lie-summary-${stamp}`,
    username: `caddie_lie_summary_${stamp}`,
    email: `caddie_lie_summary_${stamp}@example.com`,
    displayName: "Caddie Lie Summary",
    role: "player",
  }).returning({ id: appUsersTable.id });
  lieUserId = u2.id;

  // Per-lie fixture (all rows for the same user, recommendedClub set so
  // perClub aggregation also stays well-defined). The endpoint groups by
  // lieType where `accepted IS NOT NULL`.
  //
  // fairway — 3 rows: accepted prox=10, accepted prox=20, overridden prox=30
  //   total=3, accepted=2, overridden=1, accRate=2/3
  //   avgProxAccepted=15, avgProxOverridden=30
  // rough   — 2 rows: accepted prox=8, overridden prox=null
  //   total=2, accepted=1, overridden=1, accRate=0.5
  //   avgProxAccepted=8, avgProxOverridden=null (sole sample is null)
  // null    — 2 rows: accepted prox=12, overridden prox=22
  //   surfaces in perLie under "unknown"
  //   total=2, accepted=1, overridden=1, accRate=0.5
  //   avgProxAccepted=12, avgProxOverridden=22
  // bunker  — 1 row pending (accepted IS NULL) → excluded by WHERE clause
  await db.insert(caddieRecommendationsTable).values([
    // fairway
    { userId: lieUserId, holeNumber: 1, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "fairway",
      accepted: true,  outcomeDistanceToPin: "10" },
    { userId: lieUserId, holeNumber: 2, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "fairway",
      accepted: true,  outcomeDistanceToPin: "20" },
    { userId: lieUserId, holeNumber: 3, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "fairway",
      accepted: false, outcomeDistanceToPin: "30" },
    // rough
    { userId: lieUserId, holeNumber: 4, distanceYards: "140",
      recommendedClub: "8 Iron", lieType: "rough",
      accepted: true,  outcomeDistanceToPin: "8" },
    { userId: lieUserId, holeNumber: 5, distanceYards: "140",
      recommendedClub: "8 Iron", lieType: "rough",
      accepted: false, outcomeDistanceToPin: null },
    // unknown (lieType = null)
    { userId: lieUserId, holeNumber: 6, distanceYards: "130",
      recommendedClub: "9 Iron", lieType: null,
      accepted: true,  outcomeDistanceToPin: "12" },
    { userId: lieUserId, holeNumber: 7, distanceYards: "130",
      recommendedClub: "9 Iron", lieType: null,
      accepted: false, outcomeDistanceToPin: "22" },
    // bunker — pending, must be filtered out of perLie
    { userId: lieUserId, holeNumber: 8, distanceYards: "100",
      recommendedClub: "PW", lieType: "bunker",
      accepted: null, outcomeDistanceToPin: null },
  ]);

  recommendUser = {
    id: recommendUserId,
    username: `caddie_elev_recommend_${stamp}`,
    role: "player",
  };
  lieUser = {
    id: lieUserId,
    username: `caddie_lie_summary_${stamp}`,
    role: "player",
  };
  recommendApp = createTestApp(recommendUser);
  lieApp = createTestApp(lieUser);
});

afterAll(async () => {
  if (recommendUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, recommendUserId));
  }
  if (lieUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, lieUserId));
  }
});

describe("GET /portal/caddie/recommend — elevation + lie persistence", () => {
  it("stores elevationDeltaYards and lieType on the persisted row", async () => {
    const res = await request(recommendApp)
      .get(RECOMMEND_URL)
      .query({
        distanceYards: "150",
        holeNumber: "4",
        round: "1",
        elevationDeltaYards: "8.5",
        lieType: "rough",
      });
    expect(res.status).toBe(200);
    expect(res.body.recommendationId).toBeTypeOf("number");

    const [row] = await db
      .select({
        elevationDeltaYards: caddieRecommendationsTable.elevationDeltaYards,
        lieType: caddieRecommendationsTable.lieType,
        userId: caddieRecommendationsTable.userId,
        holeNumber: caddieRecommendationsTable.holeNumber,
      })
      .from(caddieRecommendationsTable)
      .where(eq(caddieRecommendationsTable.id, res.body.recommendationId));

    expect(row).toBeDefined();
    expect(row.userId).toBe(recommendUserId);
    expect(row.holeNumber).toBe(4);
    // Numeric column → comes back as a string from drizzle.
    expect(parseFloat(row.elevationDeltaYards as unknown as string)).toBeCloseTo(8.5, 6);
    expect(row.lieType).toBe("rough");
  });

  it("defaults elevation to 0 and lie to null when query params are omitted", async () => {
    const res = await request(recommendApp)
      .get(RECOMMEND_URL)
      .query({ distanceYards: "120", holeNumber: "5", round: "1" });
    expect(res.status).toBe(200);
    expect(res.body.recommendationId).toBeTypeOf("number");

    const [row] = await db
      .select({
        elevationDeltaYards: caddieRecommendationsTable.elevationDeltaYards,
        lieType: caddieRecommendationsTable.lieType,
      })
      .from(caddieRecommendationsTable)
      .where(eq(caddieRecommendationsTable.id, res.body.recommendationId));

    expect(parseFloat(row.elevationDeltaYards as unknown as string)).toBe(0);
    expect(row.lieType).toBeNull();
  });

  it("clamps absurd elevation values into the supported ±100y range", async () => {
    const res = await request(recommendApp)
      .get(RECOMMEND_URL)
      .query({
        distanceYards: "150",
        holeNumber: "6",
        round: "1",
        elevationDeltaYards: "9999",
        lieType: "fairway",
      });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({
        elevationDeltaYards: caddieRecommendationsTable.elevationDeltaYards,
        lieType: caddieRecommendationsTable.lieType,
      })
      .from(caddieRecommendationsTable)
      .where(eq(caddieRecommendationsTable.id, res.body.recommendationId));
    expect(parseFloat(row.elevationDeltaYards as unknown as string)).toBe(100);
    expect(row.lieType).toBe("fairway");
  });

  // Clean up the rows the recommend endpoint persisted for this user so the
  // per-lie fixture for the OTHER user remains the only data we assert on.
  afterAll(async () => {
    await db
      .delete(caddieRecommendationsTable)
      .where(eq(caddieRecommendationsTable.userId, recommendUserId));
  });
});

describe("GET /portal/caddie/feedback/summary — perLie aggregation", () => {
  it("groups recommendations by lie type with correct counts and acceptance rates", async () => {
    const res = await request(lieApp).get(SUMMARY_URL);
    expect(res.status).toBe(200);

    const perLie = res.body.perLie as Array<{
      lie: string;
      total: number;
      accepted: number;
      overridden: number;
      acceptanceRate: number;
      avgProximityAccepted: number | null;
      avgProximityOverridden: number | null;
    }>;
    expect(Array.isArray(perLie)).toBe(true);

    const byLie = Object.fromEntries(perLie.map(r => [r.lie, r]));

    // bunker was pending-only → filtered out by `accepted IS NOT NULL`.
    expect(Object.keys(byLie).sort()).toEqual(["fairway", "rough", "unknown"]);

    expect(byLie.fairway.total).toBe(3);
    expect(byLie.fairway.accepted).toBe(2);
    expect(byLie.fairway.overridden).toBe(1);
    expect(byLie.fairway.acceptanceRate).toBeCloseTo(2 / 3, 6);
    expect(byLie.fairway.avgProximityAccepted).toBe(15); // (10+20)/2
    expect(byLie.fairway.avgProximityOverridden).toBe(30);

    expect(byLie.rough.total).toBe(2);
    expect(byLie.rough.accepted).toBe(1);
    expect(byLie.rough.overridden).toBe(1);
    expect(byLie.rough.acceptanceRate).toBeCloseTo(0.5, 6);
    expect(byLie.rough.avgProximityAccepted).toBe(8);
    // Sole overridden sample for rough has null prox → excluded from the avg.
    expect(byLie.rough.avgProximityOverridden).toBeNull();
  });

  it("buckets null lieType rows into the 'unknown' lie", async () => {
    const res = await request(lieApp).get(SUMMARY_URL);
    expect(res.status).toBe(200);
    const perLie = res.body.perLie as Array<{
      lie: string;
      total: number;
      accepted: number;
      overridden: number;
      acceptanceRate: number;
      avgProximityAccepted: number | null;
      avgProximityOverridden: number | null;
    }>;
    const unknown = perLie.find(r => r.lie === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.total).toBe(2);
    expect(unknown!.accepted).toBe(1);
    expect(unknown!.overridden).toBe(1);
    expect(unknown!.acceptanceRate).toBeCloseTo(0.5, 6);
    expect(unknown!.avgProximityAccepted).toBe(12);
    expect(unknown!.avgProximityOverridden).toBe(22);
  });

  it("sorts perLie by total desc", async () => {
    const res = await request(lieApp).get(SUMMARY_URL);
    const totals = (res.body.perLie as Array<{ total: number }>).map(r => r.total);
    const sorted = [...totals].sort((a, b) => b - a);
    expect(totals).toEqual(sorted);
  });
});
