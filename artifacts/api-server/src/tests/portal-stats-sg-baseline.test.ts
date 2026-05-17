/**
 * Task #1643 — Match strokes-gained baseline to each player's handicap
 * automatically (auto-pick + pin-override pattern, mirroring Task #1349
 * for the proximity-by-club chart).
 *
 * The endpoints under test:
 *   GET /api/portal/stats
 *     → `strokesGained` block now carries `preferredBaseline`,
 *       `primaryBaseline`, `baselineSource`, and `handicapIndex` so the
 *       Stats card can render "Auto-picked from your 12.4 handicap → 10-hcp"
 *       vs "Pinned to scratch" copy and a picker (auto / scratch / 10 / 18).
 *
 *   PUT /api/portal/player/sg-baseline-preference
 *     → persists the player's pinned baseline to
 *       `app_users.preferred_sg_baseline`. Sending `{ baseline: 'auto' }`
 *       clears the pin and re-enables handicap-derived auto-pick.
 *
 * The auto-pick thresholds (mirrored from `pickPrimarySgBaseline` in
 * `lib/strokes-gained.ts`, which itself mirrors
 * `pickPrimaryProximityBaseline` so the SG and proximity cards always
 * recommend the same cohort tier for a given handicap):
 *
 *   HI ≤ 4   → 'scratch'   (low-single-digit / scratch-class players)
 *   HI ≤ 12  → '10'        (mid-amateurs around the 10-hcp baseline)
 *   HI > 12  → '18'        (mid- and high-handicappers)
 *   HI null  → '18'        (no handicap on file → broadest cohort)
 *
 * These tests pin all four buckets + the threshold edge at 12.4 (must
 * land in '18' to enforce parity with proximity) + the override + the
 * PUT round-trip + the input-validation, so a future change to the
 * cut-points or the persistence path is caught by CI before it ships.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
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
    name: `T1643_${stamp}`, slug: `t1643-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T1643 Course", slug: `t1643-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T1643 Tournament ${stamp}`, status: "completed",
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t1643-user-${stamp}`,
    username: `t1643_user_${stamp}`,
    email: `t1643-${stamp}@example.test`,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  // Player registration starts with NO handicap on file so the first test
  // exercises the "default" branch (no HI → broadest cohort '18').
  const [p] = await db.insert(playersTable).values({
    tournamentId, userId,
    firstName: "Sam", lastName: "Stroke",
    email: `t1643-${stamp}@example.test`,
    handicapIndex: null,
  }).returning({ id: playersTable.id });
  playerId = p.id;

  // Seed a complete 9-hole round so the stats endpoint returns a non-null
  // strokesGained block (the route requires a completed round to compute
  // SG; no shots are needed because we only assert the metadata fields).
  const now = new Date();
  await db.insert(scoresTable).values(
    Array.from({ length: 9 }, (_, i) => ({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: i + 1,
      strokes: 4,
      putts: 2,
      fairwayHit: true,
      girHit: true,
      submittedAt: now,
      updatedAt: now,
    })),
  );
});

afterAll(async () => {
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function asPlayerApp() {
  return createTestApp({ id: userId, username: "t1643_user", role: "member" });
}

describe("GET /portal/stats — Task #1643 SG baseline auto-pick + pin-override", () => {
  it("falls back to the broadest cohort ('18') and source='default' when no handicap is on file", async () => {
    // Belt-and-braces: also ensure no pinned preference is on file.
    await db.update(appUsersTable)
      .set({ preferredSgBaseline: null })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: null })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained).toBeTruthy();
    // No HI anywhere → default branch → broadest cohort '18'.
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("default");
    expect(res.body.strokesGained.handicapIndex).toBeNull();
  });

  it("auto-picks 'scratch' for a low-single-digit handicap (3.0)", async () => {
    await db.update(appUsersTable)
      .set({ preferredSgBaseline: null })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: "3.0" })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("scratch");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
    expect(res.body.strokesGained.handicapIndex).toBe(3);
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
  });

  it("auto-picks '10' for a mid-amateur handicap (8.0) so the SG numbers are personal, not scratch-class", async () => {
    await db.update(appUsersTable)
      .set({ preferredSgBaseline: null })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: "8.0" })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    // 8.0 sits comfortably in the (4, 12] band → '10' cohort.
    expect(res.body.strokesGained.primaryBaseline).toBe("10");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
    expect(res.body.strokesGained.handicapIndex).toBe(8);
  });

  it("places the headline 12.4-handicap example in '18' to keep parity with proximity (≤12 → '10', >12 → '18')", async () => {
    // The task brief uses "Auto-picked from your 12.4 handicap" as the
    // example source-copy string. Because the SG thresholds mirror
    // proximity (which cuts at ≤12), 12.4 lands in '18' — not '10'.
    // This test pins that parity so a drift in either resolver is caught.
    await db.update(appUsersTable)
      .set({ preferredSgBaseline: null })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: "12.4" })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
    expect(res.body.strokesGained.handicapIndex).toBe(12.4);
  });

  it("auto-picks '18' for a high-handicap player (22.0)", async () => {
    await db.update(appUsersTable)
      .set({ preferredSgBaseline: null })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: "22.0" })
      .where(eq(playersTable.id, playerId));

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
    expect(res.body.strokesGained.handicapIndex).toBe(22);
  });

  it("honours the ?baseline= query-string override over auto-derivation", async () => {
    // Player is still on 22.0 hcp from the previous case → auto would say
    // '18', but ?baseline=scratch should win and report source='preference'.
    const res = await request(asPlayerApp())
      .get("/api/portal/stats?baseline=scratch");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("scratch");
    expect(res.body.strokesGained.baselineSource).toBe("preference");
    // The query override is one-off: it must NOT mutate the persisted
    // preference (still 'auto' on the user row).
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
  });

  it("ignores invalid ?baseline= values and falls back to auto-derivation", async () => {
    const res = await request(asPlayerApp())
      .get("/api/portal/stats?baseline=garbage");
    expect(res.status).toBe(200);
    // 22.0 hcp → still '18' via auto-derivation.
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
  });
});

describe("PUT /portal/player/sg-baseline-preference — Task #1643 persistence", () => {
  it("persists a pinned preference and returns it on the next GET", async () => {
    const put = await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "scratch" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferredBaseline: "scratch" });

    // GET should now report the pinned baseline as primary, with
    // source='preference' (regardless of the underlying 22.0 handicap).
    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("scratch");
    expect(res.body.strokesGained.primaryBaseline).toBe("scratch");
    expect(res.body.strokesGained.baselineSource).toBe("preference");
  });

  it("clears the pin when 'auto' is sent and re-enables handicap-derived auto-pick", async () => {
    const put = await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "auto" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ preferredBaseline: "auto" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
    // Player is on 22.0 hcp → back to '18' via the handicap branch.
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
  });

  it("rejects unknown baseline values with 400", async () => {
    const res = await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "pro-tour" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing baseline body with 400", async () => {
    const res = await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({});
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(createTestApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "scratch" });
    // Unauthenticated → 401 (route uses requirePlayer guard).
    expect(res.status).toBe(401);
  });
});

/**
 * Task #2048 — Auto-update SG baseline notice when handicap changes.
 *
 * The contract under test:
 *   GET /api/portal/stats
 *     → `strokesGained.baselineChange` is `null` on the very first
 *       sighting (we lazy-seed `last_seen_auto_sg_baseline` so we never
 *       fire a notice on first visit) and on every subsequent fetch
 *       *until* the auto-derived cohort moves; then it surfaces
 *       `{ previousBaseline, currentBaseline }` so the UI can render
 *       the "Your benchmark moved" banner.
 *
 *   POST /api/portal/player/sg-baseline-change-ack
 *     → Always advances `last_seen_auto_sg_baseline` (so the same
 *       notice stops firing — that's the "dismissal is remembered"
 *       requirement). When `{ pin }` is provided, also pins
 *       `preferred_sg_baseline` to that cohort, which powers the
 *       "Pin previous baseline" shortcut.
 *
 *   PUT /api/portal/player/sg-baseline-preference (Task #1643)
 *     → Now also bumps `last_seen_auto_sg_baseline` so that a future
 *       switch back to "auto" doesn't immediately re-fire a stale
 *       notice for a threshold the player has effectively already
 *       acknowledged by interacting with the picker.
 *
 * The notice should NOT surface when:
 *   - Player has a pinned preference (they're not on auto, so the
 *     auto cohort moving is irrelevant to what they see).
 *   - Player has no handicap on file (no auto cohort to compare against).
 *   - It's the first-ever fetch (we lazy-seed and stay quiet).
 *   - The auto cohort hasn't actually moved since the last seen value.
 */
describe("Task #2048 — SG baseline change notice", () => {
  // Reset the lastSeen + preference + handicap before each scenario so
  // tests are order-independent. The test fixture user is shared across
  // the file via `userId`/`playerId` from the top-level beforeAll.
  async function resetUser(opts: { handicap?: string | null; lastSeen?: "scratch" | "10" | "18" | null; preference?: "scratch" | "10" | "18" | null } = {}) {
    await db.update(appUsersTable)
      .set({
        preferredSgBaseline: opts.preference ?? null,
        lastSeenAutoSgBaseline: opts.lastSeen ?? null,
      })
      .where(eq(appUsersTable.id, userId));
    await db.update(playersTable)
      .set({ handicapIndex: opts.handicap ?? null })
      .where(eq(playersTable.id, playerId));
  }

  it("returns baselineChange=null on the first-ever fetch (lazy-seeds lastSeen instead of firing a notice)", async () => {
    // Fresh state: HI=8.0 → auto cohort is '10', lastSeen is null.
    // The endpoint should record '10' as lastSeen and keep the notice
    // suppressed so a brand-new player doesn't get a notice for a
    // baseline they've never seen.
    await resetUser({ handicap: "8.0", lastSeen: null });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("10");
    // Critical: even though the auto cohort is '10' and lastSeen was
    // null, the response must NOT carry a notice — the endpoint
    // lazy-seeds instead. The persistence side-effect is exercised by
    // the dedicated "ack endpoint dismisses…" and "PUT preference also
    // advances lastSeen…" tests below, which set lastSeen explicitly so
    // they don't rely on the fire-and-forget write timing.
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });

  it("surfaces baselineChange when the auto cohort moves (e.g. player improves from 18 → 10)", async () => {
    // Player was previously seen at the '18' cohort (lastSeen='18'),
    // but their handicap has dropped to 8.0 → auto now picks '10'.
    // This is exactly the "18 → 10" example from the task brief.
    await resetUser({ handicap: "8.0", lastSeen: "18" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("10");
    expect(res.body.strokesGained.baselineChange).toEqual({
      previousBaseline: "18",
      currentBaseline: "10",
    });
  });

  it("does NOT surface baselineChange when the player has a pinned preference (they're not on auto)", async () => {
    // Even though the auto cohort would have moved (lastSeen='18',
    // current auto would be '10'), the player has pinned 'scratch' —
    // the notice is irrelevant to what they're actually looking at.
    await resetUser({ handicap: "8.0", lastSeen: "18", preference: "scratch" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("scratch");
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });

  it("does NOT surface baselineChange when the player has no handicap on file", async () => {
    // No HI anywhere → no auto cohort transition is meaningful.
    // Stale lastSeen='10' should be ignored, not used as a comparison.
    await resetUser({ handicap: null, lastSeen: "10" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.handicapIndex).toBeNull();
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });

  it("does NOT surface baselineChange when the auto cohort hasn't moved since lastSeen", async () => {
    // HI=8.0 → auto='10', lastSeen='10' → no move, no notice.
    await resetUser({ handicap: "8.0", lastSeen: "10" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.primaryBaseline).toBe("10");
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });

  it("ack endpoint dismisses the notice (advances lastSeen so subsequent GETs return baselineChange=null)", async () => {
    // Set up the 18→10 scenario, ack it, then refetch.
    await resetUser({ handicap: "8.0", lastSeen: "18" });

    const ack = await request(asPlayerApp())
      .post("/api/portal/player/sg-baseline-change-ack")
      .send({});
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({
      acknowledged: true,
      preferredBaseline: "auto",
      lastSeenAutoSgBaseline: "10",
    });

    // Notice should no longer fire on the next fetch.
    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.baselineChange).toBeNull();
    // Preference should still be 'auto' (we didn't pin anything).
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
  });

  it("ack endpoint with `{ pin }` pins the previous baseline (the 'Pin previous baseline' shortcut)", async () => {
    // Same 18→10 scenario; this time the player wants to keep
    // comparing against the 18-hcp cohort.
    await resetUser({ handicap: "8.0", lastSeen: "18" });

    const ack = await request(asPlayerApp())
      .post("/api/portal/player/sg-baseline-change-ack")
      .send({ pin: "18" });
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({
      acknowledged: true,
      preferredBaseline: "18",
      lastSeenAutoSgBaseline: "10",
    });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    // Pinned to '18' regardless of the 8.0 handicap.
    expect(res.body.strokesGained.preferredBaseline).toBe("18");
    expect(res.body.strokesGained.primaryBaseline).toBe("18");
    expect(res.body.strokesGained.baselineSource).toBe("preference");
    // No more notice (lastSeen was advanced, and player is no longer on auto anyway).
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });

  it("ack endpoint rejects unknown pin values with 400", async () => {
    await resetUser({ handicap: "8.0", lastSeen: "18" });
    const res = await request(asPlayerApp())
      .post("/api/portal/player/sg-baseline-change-ack")
      .send({ pin: "pro-tour" });
    expect(res.status).toBe(400);
  });

  it("ack endpoint requires authentication", async () => {
    const res = await request(createTestApp())
      .post("/api/portal/player/sg-baseline-change-ack")
      .send({});
    expect(res.status).toBe(401);
  });

  it("PUT preference also advances lastSeen — pinning then unpinning doesn't re-fire a stale notice", async () => {
    // Scenario: player was at 18-hcp cohort, hasn't yet seen the move
    // to 10-hcp (lastSeen='18', auto='10'). Instead of acking the
    // notice they pin 'scratch'. Later they switch back to 'auto'.
    // Without the lastSeen bump in PUT, that switch-back would
    // immediately re-fire the 18→10 notice — even though by pinning,
    // the player has effectively engaged with their baseline picker.
    await resetUser({ handicap: "8.0", lastSeen: "18" });

    // Pin 'scratch' — should also bump lastSeen to '10' (the current auto).
    await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "scratch" });

    const [pinned] = await db.select({ ls: appUsersTable.lastSeenAutoSgBaseline })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId));
    expect(pinned.ls).toBe("10");

    // Now switch back to auto — should NOT fire a notice because
    // lastSeen was already bumped to '10' on the pin.
    await request(asPlayerApp())
      .put("/api/portal/player/sg-baseline-preference")
      .send({ baseline: "auto" });

    const res = await request(asPlayerApp()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
    expect(res.body.strokesGained.baselineChange).toBeNull();
  });
});
