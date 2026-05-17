/**
 * Task #1168 — API contract test for the proximity-by-club endpoint.
 *
 *   GET /api/portal/player/proximity-by-club
 *
 * After Task #1168 added per-club tour benchmarks to the strokes-gained
 * library, every club row in the response should carry a `benchmark` field
 * that is either:
 *   - an object { clubKey, tourMeanFt, scratchMeanFt, midHandicapMeanFt }
 *     when we can normalise the player's club label, OR
 *   - explicitly `null` when the label can't be mapped to a known club
 *     (so clients never see "undefined" / missing key surprises).
 *
 * These tests pin that contract by seeding two minimal "approach → putt"
 * sequences (one with a recognised "7i" label, one with "mystery-stick")
 * and asserting both behaviours appear in the JSON response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, shotsTable } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  appUsersTable,
  handicapHistoryTable,
  whsPlayerStateTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let userId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1168_${stamp}`, slug: `t1168-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T1168 Course", slug: `t1168-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T1168 Tournament ${stamp}`, status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t1168-user-${stamp}`, username: `t1168_user_${stamp}`,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId, userId,
    firstName: "Pat", lastName: "Player",
    email: `t1168-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = p.id;

  // Seed three "approach → putt" sequences for "7i" (recognised club) and
  // three for "mystery-stick" (unmapped) — both pass the ≥3-shots-per-club
  // gate the chart applies, so we can verify benchmark behaviour in both
  // the resolved and the unresolved case.
  const recordedAt = new Date();
  const rows = [
    // 7i — three holes, three approach + putt pairs
    { holeNumber: 1, shotNumber: 1, shotType: "approach" as const, club: "7i", distanceToPin: "150" },
    { holeNumber: 1, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "5" },
    { holeNumber: 2, shotNumber: 1, shotType: "approach" as const, club: "7i", distanceToPin: "150" },
    { holeNumber: 2, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "10" },
    { holeNumber: 3, shotNumber: 1, shotType: "approach" as const, club: "7i", distanceToPin: "150" },
    { holeNumber: 3, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "8" },
    // Unrecognised club — three approach + putt pairs on different holes
    { holeNumber: 4, shotNumber: 1, shotType: "approach" as const, club: "mystery-stick", distanceToPin: "120" },
    { holeNumber: 4, shotNumber: 2, shotType: "putt" as const,     club: null,            distanceToPin: "6" },
    { holeNumber: 5, shotNumber: 1, shotType: "approach" as const, club: "mystery-stick", distanceToPin: "120" },
    { holeNumber: 5, shotNumber: 2, shotType: "putt" as const,     club: null,            distanceToPin: "7" },
    { holeNumber: 6, shotNumber: 1, shotType: "approach" as const, club: "mystery-stick", distanceToPin: "120" },
    { holeNumber: 6, shotNumber: 2, shotType: "putt" as const,     club: null,            distanceToPin: "9" },
    // Task #1348 — three "9i" approaches that finish far from the hole so
    // the coaching tip surfaces this club. Putt distance 30y → 90 ft, well
    // above the 9i tour mean (~24 ft).
    { holeNumber: 7, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 7, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "30" },
    { holeNumber: 8, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 8, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "32" },
    { holeNumber: 9, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 9, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "28" },
  ];
  for (const r of rows) {
    await db.insert(shotsTable).values({
      tournamentId,
      playerId,
      userId,
      round: 1,
      ...r,
      recordedAt,
    });
  }

  // Task #1640 — seed the *previous* 30-day window with 9i approaches that
  // finished closer to the pin (~12y → 36 ft) so the trend computed by the
  // coaching helper shows the player slipping vs the prior window. Recorded
  // 45 days ago, comfortably inside the [days, 2*days) prior bucket when the
  // endpoint is called with the default 30-day window.
  const recordedAtPrev = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const prevRows = [
    { holeNumber: 10, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 10, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "12" },
    { holeNumber: 11, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 11, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "13" },
    { holeNumber: 12, shotNumber: 1, shotType: "approach" as const, club: "9i", distanceToPin: "130" },
    { holeNumber: 12, shotNumber: 2, shotType: "putt" as const,     club: null, distanceToPin: "11" },
  ];
  for (const r of prevRows) {
    await db.insert(shotsTable).values({
      tournamentId,
      playerId,
      userId,
      round: 1,
      ...r,
      recordedAt: recordedAtPrev,
    });
  }
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function asPlayerApp() {
  return createTestApp({ id: userId, username: "t1168_user", role: "member" });
}

describe("GET /portal/player/proximity-by-club (Task #1168 — benchmark contract)", () => {
  it("attaches a tour/scratch/mid-handicap benchmark for recognised club labels", async () => {
    // Use a 365-day window so the seeded "now" shots are guaranteed in scope.
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowDays: 365 });
    expect(Array.isArray(res.body.clubs)).toBe(true);

    const seven = res.body.clubs.find((c: { club: string }) => c.club === "7i");
    expect(seven).toBeDefined();
    expect(seven.shots).toBeGreaterThanOrEqual(3);
    expect(seven.benchmark).not.toBeNull();
    expect(seven.benchmark).toMatchObject({
      clubKey: "7i",
      tourMeanFt: expect.any(Number),
      scratchMeanFt: expect.any(Number),
      midHandicapMeanFt: expect.any(Number),
    });
    // Benchmarks should follow tour < scratch < mid-handicap.
    expect(seven.benchmark.tourMeanFt).toBeLessThan(seven.benchmark.scratchMeanFt);
    expect(seven.benchmark.scratchMeanFt).toBeLessThan(seven.benchmark.midHandicapMeanFt);
  });

  it("returns benchmark = null (not undefined / missing) for unrecognised club labels", async () => {
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    const mystery = res.body.clubs.find((c: { club: string }) => c.club === "mystery-stick");
    expect(mystery).toBeDefined();
    // The contract is explicit `null`, so the property must exist and be null
    // (not absent). This protects clients that do `c.benchmark?.tourMeanFt`.
    expect("benchmark" in mystery).toBe(true);
    expect(mystery.benchmark).toBeNull();
  });

  // Task #1348 — the response carries the same coaching tips the Shot
  // Analytics panel renders ("work on this club"). The 9i seed above is
  // ~73 ft worse than tour, so it MUST appear at the top of `coachingTips`.
  it("attaches coachingTips for clubs that lag the tour benchmark", async () => {
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.coachingTips)).toBe(true);
    expect(res.body.coachingTips.length).toBeGreaterThan(0);
    expect(res.body.coachingTips.length).toBeLessThanOrEqual(2);

    const nineIron = res.body.coachingTips.find((t: { clubKey: string }) => t.clubKey === "9i");
    expect(nineIron).toBeDefined();
    expect(nineIron).toMatchObject({
      club: "9i",
      clubKey: "9i",
      shots: expect.any(Number),
      meanProximityFt: expect.any(Number),
      tourMeanFt: expect.any(Number),
      scratchMeanFt: expect.any(Number),
      midHandicapMeanFt: expect.any(Number),
      gapVsTourFt: expect.any(Number),
      aimLongFt: expect.any(Number),
      message: expect.any(String),
      caddieHint: expect.any(String),
    });
    expect(nineIron.gapVsTourFt).toBeGreaterThan(3);
    // The caddie hint is the compact one-liner the AI Caddie also appends to
    // its rationale — same string surfaced in two places, by design.
    expect(nineIron.caddieHint).toContain("9i");
    expect(nineIron.caddieHint).toContain("aim");
  });

  // Task #1640 — each tip carries a trend annotation vs the prior window so
  // players know whether their gap is closing, holding, or widening. The
  // seed data above puts the previous 9i mean at ~36 ft and the current at
  // ~90 ft, so the trend should clearly flag "slipping". The endpoint also
  // reports the previous-window start so clients can describe the comparison.
  it("includes a previous-window trend annotation on each coaching tip", async () => {
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=30`);
    expect(res.status).toBe(200);
    expect(typeof res.body.previousWindowStart).toBe("string");
    const nineIron = res.body.coachingTips.find((t: { clubKey: string }) => t.clubKey === "9i");
    expect(nineIron).toBeDefined();
    expect(nineIron.previousMeanProximityFt).toBeGreaterThan(0);
    expect(nineIron.trendVsTourFt).toBeGreaterThan(3);
    expect(typeof nineIron.trendLabel).toBe("string");
    expect(nineIron.trendLabel).toContain("slipping");
    // The label uses the configured previous-window length so clients don't
    // have to format it themselves.
    expect(nineIron.trendLabel).toMatch(/\+\d/);
  });

  it("requires authentication", async () => {
    const res = await request(createTestApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(401);
  });
});

// ── Task #1349 — Auto-pick the primary baseline from handicap index ────────
//
// The endpoint should now resolve a "primary" benchmark (tour | scratch |
// mid) for the player based on:
//   1. ?baseline= query override
//   2. their pinned preference (preferred_proximity_baseline)
//   3. fallback: derived from current handicap index
// We seed a tournament registration with a 22.0 handicap so the auto path
// returns "mid". Then we verify the override + the PUT-preference round-trip.
describe("GET /portal/player/proximity-by-club (Task #1349 — primary baseline)", () => {
  beforeAll(async () => {
    // Backfill a tournament registration handicap so the handicap-derived
    // baseline path has data to work with. The shot-seed setup above leaves
    // handicap_index null on `players`, which would otherwise short-circuit
    // to the "no handicap → mid (default)" branch — we want to exercise the
    // "handicap" branch explicitly.
    await db.update(playersTable)
      .set({ handicapIndex: "22.0" })
      .where(eq(playersTable.id, playerId));
  });

  it("auto-derives the primary baseline from the player's handicap (22.0 → mid)", async () => {
    // No override and no pinned preference → should land on mid-handicap
    // because the seeded handicap index is 22.0 (> 12 threshold).
    await db.update(appUsersTable)
      .set({ preferredProximityBaseline: null })
      .where(eq(appUsersTable.id, userId));

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.handicapIndex).toBe(22);
    expect(res.body.preferredBaseline).toBe("auto");
    expect(res.body.primaryBaseline).toBe("mid");
    expect(res.body.baselineSource).toBe("handicap");
  });

  it("honours the ?baseline= query-string override over auto-derivation", async () => {
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365&baseline=tour`);
    expect(res.status).toBe(200);
    expect(res.body.primaryBaseline).toBe("tour");
    expect(res.body.baselineSource).toBe("preference");
  });

  it("ignores invalid ?baseline= values and falls back to auto", async () => {
    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365&baseline=garbage`);
    expect(res.status).toBe(200);
    // 22.0 hcp → still mid via auto-derivation.
    expect(res.body.primaryBaseline).toBe("mid");
    expect(res.body.baselineSource).toBe("handicap");
  });

  it("persists a pinned preference via PUT and returns it on the next GET", async () => {
    const put = await request(asPlayerApp())
      .put(`/api/portal/player/proximity-baseline-preference`)
      .send({ baseline: "scratch" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferredBaseline: "scratch" });

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.preferredBaseline).toBe("scratch");
    expect(res.body.primaryBaseline).toBe("scratch");
    expect(res.body.baselineSource).toBe("preference");
  });

  it("clears the pin when 'auto' is sent and falls back to handicap-derived", async () => {
    const put = await request(asPlayerApp())
      .put(`/api/portal/player/proximity-baseline-preference`)
      .send({ baseline: "auto" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferredBaseline: "auto" });

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.preferredBaseline).toBe("auto");
    expect(res.body.primaryBaseline).toBe("mid");
    expect(res.body.baselineSource).toBe("handicap");
  });

  it("rejects unknown baseline values on PUT", async () => {
    const res = await request(asPlayerApp())
      .put(`/api/portal/player/proximity-baseline-preference`)
      .send({ baseline: "pro-tour" });
    expect(res.status).toBe(400);
  });
});

// ── Task #1644 — Surface where the handicap baseline came from ─────────────
//
// The endpoint now also returns:
//   - `handicapSource`: 'whs' | 'history' | 'profile' | null
//   - `handicapAsOf`:   ISO timestamp of that source row, or null
// so the UI can tell players "Where this comes from" and link them to the
// right place to update it. Priority order is the same as before — first
// non-null wins: WHS → handicap_history → players row.
describe("GET /portal/player/proximity-by-club (Task #1644 — handicap source provenance)", () => {
  beforeAll(async () => {
    // Reset the player so we control which sources are populated per test.
    await db.delete(handicapHistoryTable).where(eq(handicapHistoryTable.userId, userId));
    await db.delete(whsPlayerStateTable).where(eq(whsPlayerStateTable.userId, userId));
    await db.update(playersTable)
      .set({ handicapIndex: null })
      .where(eq(playersTable.id, playerId));
    await db.update(appUsersTable)
      .set({ preferredProximityBaseline: null })
      .where(eq(appUsersTable.id, userId));
  });

  it("falls back to the players row and reports source='profile' with registeredAt", async () => {
    await db.update(playersTable)
      .set({ handicapIndex: "18.0" })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.handicapIndex).toBe(18);
    expect(res.body.handicapSource).toBe("profile");
    expect(typeof res.body.handicapAsOf).toBe("string");
    expect(Number.isFinite(new Date(res.body.handicapAsOf).getTime())).toBe(true);
  });

  it("prefers handicap_history over the players row and reports source='history'", async () => {
    const recordedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.insert(handicapHistoryTable).values({
      userId,
      handicapIndex: "14.5",
      tournamentId,
      recordedAt,
    });

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.handicapIndex).toBe(14.5);
    expect(res.body.handicapSource).toBe("history");
    expect(new Date(res.body.handicapAsOf).getTime()).toBe(recordedAt.getTime());
  });

  it("prefers the live WHS state over both fallbacks and reports source='whs'", async () => {
    const lastRecalcAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await db.insert(whsPlayerStateTable).values({
      userId,
      organizationId: orgId,
      currentHandicapIndex: "9.2",
      lastRecalcAt,
    });

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.handicapIndex).toBeCloseTo(9.2, 1);
    expect(res.body.handicapSource).toBe("whs");
    expect(new Date(res.body.handicapAsOf).getTime()).toBe(lastRecalcAt.getTime());
  });

  it("returns handicapSource=null and handicapAsOf=null when no handicap is on file", async () => {
    // Strip every source so the UI knows to link the player to add one.
    await db.delete(whsPlayerStateTable).where(eq(whsPlayerStateTable.userId, userId));
    await db.delete(handicapHistoryTable).where(eq(handicapHistoryTable.userId, userId));
    await db.update(playersTable)
      .set({ handicapIndex: null })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp())
      .get(`/api/portal/player/proximity-by-club?days=365`);
    expect(res.status).toBe(200);
    expect(res.body.handicapIndex).toBeNull();
    expect(res.body.handicapSource).toBeNull();
    expect(res.body.handicapAsOf).toBeNull();
    // Without a handicap we still fall back to the default mid baseline.
    expect(res.body.baselineSource).toBe("default");
  });
});
