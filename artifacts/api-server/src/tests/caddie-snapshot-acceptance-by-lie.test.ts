/**
 * Regression test (Task #943): the offline AI Caddie snapshot endpoint must
 * expose per-(lie, club) acceptance buckets keyed by the *normalised* lie
 * label so the on-device recommender can personalise picks by lie.
 *
 * This pins two things that a future refactor could silently break:
 *   1. /portal/caddie/snapshot returns `acceptanceByLie`.
 *   2. The bucket key is the canonical lie label — both raw "sand" and raw
 *      "bunker" rows must collapse into a single "bunker" bucket.
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

let userId: number;
let user: TestUser;
let app: ReturnType<typeof createTestApp>;

const URL = "/api/portal/caddie/snapshot";

beforeAll(async () => {
  const stamp = Date.now();
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-snap-lie-${stamp}`,
    username: `caddie_snap_lie_${stamp}`,
    email: `caddie_snap_lie_${stamp}@example.com`,
    displayName: "Caddie Snap Lie",
    role: "player",
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  // 7 Iron history mixes raw "sand" and raw "bunker" lie strings — both must
  // normalise to the canonical "bunker" bucket. We also seed fairway rows so
  // the snapshot must return *separate* fairway and bunker buckets, plus a
  // single rough row that is below the >=2-sample threshold and therefore
  // must be filtered out of the per-lie response.
  //
  // bunker bucket combined: 2 sand rows (T,T) + 2 bunker rows (T,F)
  //   = 4 total, 3 accepted → acceptanceByLie.bunker["7 Iron"] = 0.75
  // fairway bucket: 2 rows (T,F) → acceptanceByLie.fairway["7 Iron"] = 0.5
  // rough bucket:   1 row → below threshold, must be absent
  // Per-club acceptance ("7 Iron"): 7 rows, 5 accepted → 5/7 ≈ 0.714
  await db.insert(caddieRecommendationsTable).values([
    { userId, holeNumber: 1, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "sand",
      accepted: true, outcomeDistanceToPin: "10" },
    { userId, holeNumber: 2, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "Sand",
      accepted: true, outcomeDistanceToPin: "12" },
    { userId, holeNumber: 3, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "bunker",
      accepted: true, outcomeDistanceToPin: "14" },
    { userId, holeNumber: 4, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "BUNKER",
      accepted: false, outcomeDistanceToPin: "30" },
    { userId, holeNumber: 5, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "fairway",
      accepted: true, outcomeDistanceToPin: "8" },
    { userId, holeNumber: 6, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "fairway",
      accepted: false, outcomeDistanceToPin: "25" },
    { userId, holeNumber: 7, distanceYards: "150",
      recommendedClub: "7 Iron", lieType: "rough",
      accepted: true, outcomeDistanceToPin: "9" },
  ]);

  user = {
    id: userId,
    username: `caddie_snap_lie_${stamp}`,
    role: "player",
  };
  app = createTestApp(user);
});

afterAll(async () => {
  if (userId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  }
});

describe("GET /portal/caddie/snapshot — acceptanceByLie", () => {
  it("requires authentication", async () => {
    const res = await request(createTestApp(undefined)).get(URL);
    expect(res.status).toBe(401);
  });

  it("returns per-(lie, club) acceptance keyed by the normalised lie label", async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);

    const acceptanceByLie = res.body.acceptanceByLie as
      Record<string, Record<string, number>>;
    expect(acceptanceByLie).toBeTypeOf("object");
    expect(acceptanceByLie).not.toBeNull();

    // Both raw "sand" and raw "bunker" rows must collapse into a single
    // "bunker" bucket — that's the entire point of normalisation.
    expect(Object.keys(acceptanceByLie).sort()).toEqual(
      ["bunker", "fairway"],
    );

    // bunker: 2 sand + 2 bunker rows = 4 total, 3 accepted → 0.75.
    expect(acceptanceByLie.bunker["7 Iron"]).toBeCloseTo(0.75, 6);
    // fairway: 2 rows, 1 accepted → 0.5.
    expect(acceptanceByLie.fairway["7 Iron"]).toBeCloseTo(0.5, 6);
  });

  it("omits per-lie buckets that fall below the minimum sample threshold", async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);
    const acceptanceByLie = res.body.acceptanceByLie as
      Record<string, Record<string, number>>;
    // Only one rough sample exists → must not appear in the snapshot.
    expect(acceptanceByLie.rough).toBeUndefined();
  });

  it("still returns the per-club acceptance summary alongside the per-lie one", async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);
    const acceptanceByClub = res.body.acceptanceByClub as Record<string, number>;
    // 7 rows for "7 Iron", 5 accepted → 5/7.
    expect(acceptanceByClub["7 Iron"]).toBeCloseTo(5 / 7, 6);
  });
});
