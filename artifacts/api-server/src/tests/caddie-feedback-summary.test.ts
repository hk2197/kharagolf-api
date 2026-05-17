/**
 * Integration tests: AI Caddie feedback summary endpoint (Task 470).
 *
 * Covers GET /api/portal/caddie/feedback/summary
 *
 *   - Empty state (no recommendations) returns zeroed aggregates
 *   - Mixed accepted/overridden/pending rows return correct totals
 *     and acceptance rate (decided-only denominator)
 *   - null outcomeDistanceToPin is excluded from avg-proximity calculations
 *   - Per-club aggregation is correct (counts, acceptanceRate, avg proxes)
 *   - mostOverriddenClubs requires sample size >= 3 and at least 1 override,
 *     and is sorted by override-rate desc
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
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let mixedUserId: number;
let emptyUserId: number;

let mixedUser: TestUser;
let emptyUser: TestUser;
let mixedApp: ReturnType<typeof createTestApp>;
let emptyApp: ReturnType<typeof createTestApp>;

const URL = "/api/portal/caddie/feedback/summary";

beforeAll(async () => {
  const stamp = Date.now();

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-summary-mixed-${stamp}`,
    username: `caddie_summary_mixed_${stamp}`,
    email: `caddie_summary_mixed_${stamp}@example.com`,
    displayName: "Caddie Summary Mixed",
    role: "player",
  }).returning({ id: appUsersTable.id });
  mixedUserId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-summary-empty-${stamp}`,
    username: `caddie_summary_empty_${stamp}`,
    email: `caddie_summary_empty_${stamp}@example.com`,
    displayName: "Caddie Summary Empty",
    role: "player",
  }).returning({ id: appUsersTable.id });
  emptyUserId = u2.id;

  // Build a varied recommendation history for the mixed user.
  //
  // 7 Iron — 4 rows: accepted prox=10, accepted prox=20, overridden prox=null,
  //                  overridden prox=40 → total 4, acc 2, ov 2, override-rate 0.5
  //                  avg-prox-accepted = 15, avg-prox-overridden = 40
  // 8 Iron — 3 rows: accepted prox=5, overridden prox=15, overridden prox=25
  //                  → total 3, acc 1, ov 2, override-rate 0.667
  //                  avg-prox-accepted = 5, avg-prox-overridden = 20
  // 6 Iron — 2 rows: accepted prox=12, overridden prox=18
  //                  → total 2 (below sample threshold for mostOverridden)
  // 9 Iron — 3 rows: all accepted, prox=8/9/11
  //                  → total 3, ov 0 → meets sample threshold but
  //                    excluded from mostOverriddenClubs because overridden=0
  // PW    — 1 row : pending (accepted IS NULL)
  //
  // Aggregate accepted: 7 (7I:2 + 8I:1 + 6I:1 + 9I:3)
  // Aggregate overridden: 5 (7I:2 + 8I:2 + 6I:1)
  // Pending: 1
  // Acceptance rate (decided only): 7 / 12
  // Avg prox accepted = (10+20+5+12+8+9+11) / 7 = 75/7 ≈ 10.714… → 10.7
  // Avg prox overridden (excluding null) = (40+15+25+18) / 4 = 24.5
  // proximityAcceptedSamples = 7
  // proximityOverriddenSamples = 4 (one null excluded)
  await db.insert(caddieRecommendationsTable).values([
    // 7 Iron
    { userId: mixedUserId, holeNumber: 1, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: true,  outcomeDistanceToPin: "10" },
    { userId: mixedUserId, holeNumber: 2, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: true,  outcomeDistanceToPin: "20" },
    { userId: mixedUserId, holeNumber: 3, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: false, outcomeDistanceToPin: null },
    { userId: mixedUserId, holeNumber: 4, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: false, outcomeDistanceToPin: "40" },
    // 8 Iron
    { userId: mixedUserId, holeNumber: 5, distanceYards: "140",
      recommendedClub: "8 Iron", accepted: true,  outcomeDistanceToPin: "5" },
    { userId: mixedUserId, holeNumber: 6, distanceYards: "140",
      recommendedClub: "8 Iron", accepted: false, outcomeDistanceToPin: "15" },
    { userId: mixedUserId, holeNumber: 7, distanceYards: "140",
      recommendedClub: "8 Iron", accepted: false, outcomeDistanceToPin: "25" },
    // 6 Iron — below sample threshold
    { userId: mixedUserId, holeNumber: 8, distanceYards: "160",
      recommendedClub: "6 Iron", accepted: true,  outcomeDistanceToPin: "12" },
    { userId: mixedUserId, holeNumber: 9, distanceYards: "160",
      recommendedClub: "6 Iron", accepted: false, outcomeDistanceToPin: "18" },
    // 9 Iron — meets sample threshold but zero overrides
    { userId: mixedUserId, holeNumber: 10, distanceYards: "130",
      recommendedClub: "9 Iron", accepted: true,  outcomeDistanceToPin: "8" },
    { userId: mixedUserId, holeNumber: 11, distanceYards: "130",
      recommendedClub: "9 Iron", accepted: true,  outcomeDistanceToPin: "9" },
    { userId: mixedUserId, holeNumber: 12, distanceYards: "130",
      recommendedClub: "9 Iron", accepted: true,  outcomeDistanceToPin: "11" },
    // PW — pending
    { userId: mixedUserId, holeNumber: 13, distanceYards: "100",
      recommendedClub: "PW", accepted: null, outcomeDistanceToPin: null },
  ]);

  mixedUser = {
    id: mixedUserId,
    username: `caddie_summary_mixed_${stamp}`,
    role: "player",
  };
  emptyUser = {
    id: emptyUserId,
    username: `caddie_summary_empty_${stamp}`,
    role: "player",
  };
  mixedApp = createTestApp(mixedUser);
  emptyApp = createTestApp(emptyUser);
});

afterAll(async () => {
  // caddie_recommendations cascade off app_users
  if (mixedUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, mixedUserId));
  }
  if (emptyUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, emptyUserId));
  }
});

describe("GET /portal/caddie/feedback/summary — auth & empty state", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(createTestApp(undefined)).get(URL);
    expect(res.status).toBe(401);
  });

  it("returns zeroed aggregates when the player has no recommendations", async () => {
    const res = await request(emptyApp).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.accepted).toBe(0);
    expect(res.body.overridden).toBe(0);
    expect(res.body.pending).toBe(0);
    expect(res.body.acceptanceRate).toBeNull();
    expect(res.body.avgProximityAccepted).toBeNull();
    expect(res.body.avgProximityOverridden).toBeNull();
    expect(res.body.proximityAcceptedSamples).toBe(0);
    expect(res.body.proximityOverriddenSamples).toBe(0);
    expect(res.body.mostOverriddenClubs).toEqual([]);
    expect(res.body.perClub).toEqual([]);
  });
});

describe("GET /portal/caddie/feedback/summary — top-level aggregates", () => {
  it("counts accepted / overridden / pending and acceptance rate uses decided-only denominator", async () => {
    const res = await request(mixedApp).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(13);
    expect(res.body.accepted).toBe(7);
    expect(res.body.overridden).toBe(5);
    expect(res.body.pending).toBe(1);
    // acceptance rate = 7 / (7+5) = 0.5833…
    expect(res.body.acceptanceRate).toBeCloseTo(7 / 12, 6);
  });

  it("excludes null outcomeDistanceToPin from avg-proximity and counts non-null samples", async () => {
    const res = await request(mixedApp).get(URL);
    // avg-prox-accepted = (10+20+5+12+8+9+11)/7 = 75/7 ≈ 10.7142… → 10.7
    expect(res.body.avgProximityAccepted).toBe(10.7);
    // avg-prox-overridden = (40+15+25+18)/4 = 24.5 (one null excluded)
    expect(res.body.avgProximityOverridden).toBe(24.5);
    expect(res.body.proximityAcceptedSamples).toBe(7);
    expect(res.body.proximityOverriddenSamples).toBe(4);
  });
});

describe("GET /portal/caddie/feedback/summary — per-club aggregation", () => {
  it("returns one row per recommended club (excluding pending-only)", async () => {
    const res = await request(mixedApp).get(URL);
    const clubs = (res.body.perClub as Array<{ club: string }>).map(c => c.club).sort();
    // PW is pending-only → filtered by `accepted IS NOT NULL`.
    expect(clubs).toEqual(["6 Iron", "7 Iron", "8 Iron", "9 Iron"]);
  });

  it("computes per-club acceptance rate, counts and avg proximities", async () => {
    const res = await request(mixedApp).get(URL);
    type ClubStat = {
      club: string;
      total: number; accepted: number; overridden: number;
      acceptanceRate: number;
      avgProximityAccepted: number | null;
      avgProximityOverridden: number | null;
    };
    const byClub = Object.fromEntries(
      (res.body.perClub as ClubStat[]).map((c) => [c.club, c]),
    );

    expect(byClub["7 Iron"].total).toBe(4);
    expect(byClub["7 Iron"].accepted).toBe(2);
    expect(byClub["7 Iron"].overridden).toBe(2);
    expect(byClub["7 Iron"].acceptanceRate).toBeCloseTo(0.5, 6);
    expect(byClub["7 Iron"].avgProximityAccepted).toBe(15); // (10+20)/2
    expect(byClub["7 Iron"].avgProximityOverridden).toBe(40); // single non-null

    expect(byClub["8 Iron"].total).toBe(3);
    expect(byClub["8 Iron"].accepted).toBe(1);
    expect(byClub["8 Iron"].overridden).toBe(2);
    expect(byClub["8 Iron"].acceptanceRate).toBeCloseTo(1 / 3, 6);
    expect(byClub["8 Iron"].avgProximityAccepted).toBe(5);
    expect(byClub["8 Iron"].avgProximityOverridden).toBe(20); // (15+25)/2

    expect(byClub["6 Iron"].total).toBe(2);
    expect(byClub["6 Iron"].accepted).toBe(1);
    expect(byClub["6 Iron"].overridden).toBe(1);

    expect(byClub["9 Iron"].total).toBe(3);
    expect(byClub["9 Iron"].accepted).toBe(3);
    expect(byClub["9 Iron"].overridden).toBe(0);
    expect(byClub["9 Iron"].acceptanceRate).toBeCloseTo(1, 6);
  });

  it("sorts perClub by total desc", async () => {
    const res = await request(mixedApp).get(URL);
    const totals = (res.body.perClub as Array<{ total: number }>).map(c => c.total);
    const sorted = [...totals].sort((a, b) => b - a);
    expect(totals).toEqual(sorted);
  });
});

describe("GET /portal/caddie/feedback/summary — mostOverriddenClubs", () => {
  it("excludes clubs with sample size < 3 and surfaces the highest override rate first", async () => {
    const res = await request(mixedApp).get(URL);
    const most = res.body.mostOverriddenClubs as Array<{
      club: string; overridden: number; total: number; overrideRate: number;
    }>;
    // 6 Iron has only 2 rows → excluded by sample threshold.
    // 9 Iron has 3 rows but 0 overrides → excluded by override>0 filter.
    // 7 Iron (4 rows, 2 ov, rate 0.5) and 8 Iron (3 rows, 2 ov, rate 0.667)
    // → 8 Iron must come first.
    const clubs = most.map(c => c.club);
    expect(clubs).toEqual(["8 Iron", "7 Iron"]);
    expect(clubs).not.toContain("9 Iron");
    expect(clubs).not.toContain("6 Iron");
    expect(most[0].overrideRate).toBeCloseTo(2 / 3, 6);
    expect(most[1].overrideRate).toBeCloseTo(0.5, 6);
    expect(most[0].overridden).toBe(2);
    expect(most[0].total).toBe(3);
  });
});
