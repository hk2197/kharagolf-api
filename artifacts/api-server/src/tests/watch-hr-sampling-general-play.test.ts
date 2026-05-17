/**
 * Watch heart-rate sampling start/stop — Task #718.
 *
 * Mirrors the four Task #561 scenarios (see watch-hr-sampling.test.ts) but
 * exercises the casual general-play path (`generalPlayRoundId`) instead of
 * the tournament path (`tournamentId`).
 *
 * Both the portal HR ingest endpoint (POST /api/portal/hr-samples) and the
 * watch bridge accept either id, but Task #561's coverage hits only the
 * tournament branch. These tests guarantee that casual rounds get the same
 * start/stop and per-shot tagging behaviour so the post-round HR strip on
 * the stats screen is reliable for general play too.
 *
 * The four scenarios:
 *   1. capture-on at round start triggers sampling and tagged samples
 *      reach /api/portal/hr-samples (and land in hr_samples with the
 *      correct generalPlayRoundId).
 *   2. capture-off at round start results in no sampling / no POSTs.
 *   3. Toggling capture off mid-round stops sampling and no further
 *      samples are accepted (route refuses with rejected=no_consent).
 *   4. Per-shot/per-hole context tagging is forwarded on each batch and
 *      rows in hr_samples carry the correct generalPlayRoundId / round /
 *      holeNumber / shotNumber.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  appUsersTable,
  coursesTable,
  generalPlayRoundsTable,
  hrSamplesTable,
  organizationsTable,
  userHealthPrefsTable,
  db,
} from "@workspace/db";
import { createTestApp, type TestUser } from "./helpers.js";

// ── Test fixtures ────────────────────────────────────────────────────
let testOrgId: number;
let testCourseId: number;
let testGeneralPlayRoundId: number;
let testUserId: number;
let testUser: TestUser;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HrSamplingGP_${stamp}`,
    slug: `test-hr-sampling-gp-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "HR Sampling GP Course",
    slug: `hr-sampling-gp-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `hr-sampling-gp-test-${stamp}`,
    username: `hr_sampling_gp_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [gpRound] = await db.insert(generalPlayRoundsTable).values({
    userId: testUserId,
    organizationId: testOrgId,
    courseId: testCourseId,
    holesPlayed: 18,
    status: "in_progress",
  }).returning({ id: generalPlayRoundsTable.id });
  testGeneralPlayRoundId = gpRound.id;

  testUser = { id: testUserId, username: `hr_sampling_gp_test_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(hrSamplesTable).where(eq(hrSamplesTable.userId, testUserId));
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, testUserId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, testGeneralPlayRoundId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  // Wipe per-test state so toggle-off scenarios are not contaminated by
  // earlier inserts.
  await db.delete(hrSamplesTable).where(eq(hrSamplesTable.userId, testUserId));
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, testUserId));
});

// ── Mock watch bridge + fake watch ───────────────────────────────────
//
// Same shape as watch-hr-sampling.test.ts; see that file for an in-depth
// commentary on what the mock represents. The only difference here is
// that the active context carries `generalPlayRoundId` instead of
// `tournamentId`, which the phone forwards through to the portal.

interface HrContext {
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  playerId?: number | null;
  round?: number | null;
  holeNumber?: number | null;
  shotNumber?: number | null;
}

interface HrBurst {
  hrBpm: number;
  hrvMs?: number | null;
  stressScore?: number | null;
  recordedAt: string;
}

function makeMockBridge(app: ReturnType<typeof createTestApp>) {
  let authToken: string | null = null;
  let baseURL: string | null = null;
  let context: HrContext = {};
  const calls = {
    hrStart: 0,
    hrStop: 0,
    hrPushContext: 0,
    posts: [] as Array<{ status: number; body: unknown; sentSamples: HrBurst[]; tagged: HrContext }>,
  };

  const bridge = {
    async hrStart(token: string, base: string, ctx: HrContext) {
      authToken = token;
      baseURL = base;
      context = { ...ctx };
      calls.hrStart += 1;
      // Mirror the native bridge: announce the active session to the
      // server so the ingest endpoint will accept incoming batches.
      await request(app)
        .post("/api/portal/hr-samples/session")
        .set("Authorization", `Bearer ${token}`)
        .send({ action: "start" });
    },
    async hrStop() {
      const tokenForEnd = authToken;
      authToken = null;
      baseURL = null;
      context = {};
      calls.hrStop += 1;
      // Tell the server to drop the active-session marker so any
      // straggling sample POSTs are refused with `session_inactive`.
      if (tokenForEnd) {
        await request(app)
          .post("/api/portal/hr-samples/session")
          .set("Authorization", `Bearer ${tokenForEnd}`)
          .send({ action: "end" });
      }
    },
    async hrPushContext(ctx: HrContext) {
      context = { ...context, ...ctx };
      calls.hrPushContext += 1;
    },
    isSampling() {
      return authToken != null;
    },
    /** Simulate the watch delivering a batch of HR samples to the phone. */
    async deliverFromWatch(samples: HrBurst[]) {
      if (!authToken) {
        // Bridge cleared — phone drops the batch on the floor (no POST).
        return;
      }
      const tagged: HrContext = { ...context };
      const payload = {
        tournamentId: tagged.tournamentId ?? null,
        generalPlayRoundId: tagged.generalPlayRoundId ?? null,
        playerId: tagged.playerId ?? null,
        round: tagged.round ?? 1,
        samples: samples.map(s => ({
          hrBpm: s.hrBpm,
          hrvMs: s.hrvMs ?? null,
          stressScore: s.stressScore ?? null,
          recordedAt: s.recordedAt,
          holeNumber: tagged.holeNumber ?? null,
          shotNumber: tagged.shotNumber ?? null,
          source: "apple_watch",
        })),
      };
      const res = await request(app)
        .post("/api/portal/hr-samples")
        .set("Authorization", `Bearer ${authToken}`)
        .send(payload);
      calls.posts.push({
        status: res.status,
        body: res.body,
        sentSamples: samples,
        tagged,
      });
      void baseURL; // satisfy noUnusedLocals — only the token matters in tests
    },
  };

  return { bridge, calls };
}

// ── Phone orchestrator (mirrors score.tsx HR-capture useEffects) ─────
//
// Identical to the tournament version except `session` carries a
// `generalPlayRoundId` rather than a `tournamentId` and (matching the
// real casual-play flow) there is no `playerId` because general-play
// rounds are not tied to a tournament players row.

function makePhoneOrchestrator(
  app: ReturnType<typeof createTestApp>,
  bridge: ReturnType<typeof makeMockBridge>["bridge"],
  session: { generalPlayRoundId: number; round: number },
) {
  let active = false;
  const state = { holeNumber: 1 as number, shotNumber: 1 as number };

  const buildCtx = (): HrContext => ({
    generalPlayRoundId: session.generalPlayRoundId,
    round:              session.round,
    holeNumber:         state.holeNumber,
    shotNumber:         state.shotNumber,
  });

  return {
    state,
    isActive: () => active,
    /** Re-checks /health-prefs and starts or stops sampling accordingly. */
    async evaluate() {
      const res = await request(app).get("/api/portal/health-prefs");
      const want = res.status === 200 && !!(res.body?.hrCaptureEnabled);
      if (want && !active) {
        await bridge.hrStart("test-bearer-token", "http://localhost", buildCtx());
        active = true;
      } else if (!want && active) {
        await bridge.hrStop();
        active = false;
      }
    },
    async setHole(holeNumber: number, shotNumber: number) {
      state.holeNumber = holeNumber;
      state.shotNumber = shotNumber;
      if (active) await bridge.hrPushContext(buildCtx());
    },
    async unmount() {
      if (active) {
        await bridge.hrStop();
        active = false;
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────
async function setCaptureEnabled(app: ReturnType<typeof createTestApp>, enabled: boolean) {
  const res = await request(app)
    .put("/api/portal/health-prefs")
    .send({ hrCaptureEnabled: enabled });
  expect(res.status).toBe(200);
  expect(res.body.hrCaptureEnabled).toBe(enabled);
}

async function loadSamples() {
  return db
    .select()
    .from(hrSamplesTable)
    .where(and(
      eq(hrSamplesTable.userId, testUserId),
      eq(hrSamplesTable.generalPlayRoundId, testGeneralPlayRoundId),
    ));
}

const baseBurst = (offsetMs: number, hrBpm = 92): HrBurst => ({
  hrBpm,
  hrvMs: 42.5,
  stressScore: 30,
  recordedAt: new Date(Date.now() + offsetMs).toISOString(),
});

// ── Tests ────────────────────────────────────────────────────────────

describe("watch HR sampling (general play) — capture toggle drives the bridge + portal ingest", () => {
  it("capture-on at general-play round start triggers sampling and tagged samples reach /portal/hr-samples", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      generalPlayRoundId: testGeneralPlayRoundId,
      round: 1,
    });

    await orch.evaluate(); // round start

    expect(calls.hrStart).toBe(1);
    expect(calls.hrStop).toBe(0);
    expect(bridge.isSampling()).toBe(true);

    await orch.setHole(1, 1);
    await bridge.deliverFromWatch([baseBurst(0, 95), baseBurst(2000, 101)]);

    expect(calls.posts.length).toBe(1);
    const post = calls.posts[0];
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ inserted: 2, rejected: null });

    const rows = await loadSamples();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.generalPlayRoundId).toBe(testGeneralPlayRoundId);
      expect(r.tournamentId).toBeNull();
      expect(r.playerId).toBeNull();
      expect(r.round).toBe(1);
      expect(r.holeNumber).toBe(1);
      expect(r.shotNumber).toBe(1);
      expect(r.source).toBe("apple_watch");
    }

    await orch.unmount();
    expect(calls.hrStop).toBe(1);
    expect(bridge.isSampling()).toBe(false);
  });

  it("capture-off at general-play round start results in no sampling and no POSTs", async () => {
    const app = createTestApp(testUser);
    // Default state for a fresh user is captureEnabled=false; make it explicit.
    await setCaptureEnabled(app, false);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      generalPlayRoundId: testGeneralPlayRoundId,
      round: 1,
    });

    await orch.evaluate();

    expect(calls.hrStart).toBe(0);
    expect(bridge.isSampling()).toBe(false);

    // Even if a rogue watch tried to deliver samples, the phone bridge has
    // no auth token stashed and so makes no network call.
    await bridge.deliverFromWatch([baseBurst(0, 88)]);
    expect(calls.posts.length).toBe(0);

    const rows = await loadSamples();
    expect(rows.length).toBe(0);
  });

  it("toggling capture off mid-general-play-round stops sampling and no further samples are accepted", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      generalPlayRoundId: testGeneralPlayRoundId,
      round: 1,
    });

    // Round start — sampling on.
    await orch.evaluate();
    await orch.setHole(3, 1);
    await bridge.deliverFromWatch([baseBurst(0, 110)]);
    expect(calls.posts.length).toBe(1);
    expect(calls.posts[0].status).toBe(200);
    expect(calls.posts[0].body).toMatchObject({ inserted: 1, rejected: null });

    // Player flips capture off in the Stats tab mid-round.
    await setCaptureEnabled(app, false);
    await orch.evaluate(); // simulates app foregrounding / focus regain

    expect(calls.hrStop).toBe(1);
    expect(bridge.isSampling()).toBe(false);

    // Watch tries to keep streaming — bridge drops, so no POST.
    await bridge.deliverFromWatch([baseBurst(5000, 118)]);
    expect(calls.posts.length).toBe(1); // unchanged

    // Even if a stale POST does sneak through (e.g. an in-flight request
    // queued before hrStop), the portal route refuses it with no_consent
    // because the user-level flag is now off. Simulate that by issuing one
    // directly and checking the response.
    const stale = await request(app)
      .post("/api/portal/hr-samples")
      .set("Authorization", "Bearer stale-token")
      .send({
        generalPlayRoundId: testGeneralPlayRoundId,
        round: 1,
        samples: [{ ...baseBurst(6000, 120), holeNumber: 3, shotNumber: 2, source: "apple_watch" }],
      });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ inserted: 0, rejected: "no_consent" });

    // Only the pre-toggle sample survived in the database.
    const rows = await loadSamples();
    expect(rows.length).toBe(1);
    expect(rows[0].hrBpm).toBe(110);
    expect(rows[0].generalPlayRoundId).toBe(testGeneralPlayRoundId);
    expect(rows[0].tournamentId).toBeNull();
  });

  it("forwards per-shot/per-hole context tagging on each batch (general-play round)", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      generalPlayRoundId: testGeneralPlayRoundId,
      round: 1,
    });

    await orch.evaluate();
    expect(calls.hrStart).toBe(1);

    // Hole 5, shot 1 → first batch
    await orch.setHole(5, 1);
    await bridge.deliverFromWatch([baseBurst(0, 96)]);

    // Hole 5, shot 2 → second batch (context push between shots)
    await orch.setHole(5, 2);
    await bridge.deliverFromWatch([baseBurst(2000, 104)]);

    // Hole 6, shot 1 → third batch (context push on hole change)
    await orch.setHole(6, 1);
    await bridge.deliverFromWatch([baseBurst(4000, 88), baseBurst(5000, 90)]);

    expect(calls.hrPushContext).toBeGreaterThanOrEqual(2);
    expect(calls.posts.length).toBe(3);

    // The bridge must have stamped the correct context (including the
    // generalPlayRoundId) onto each POST it sent.
    const sent = calls.posts.map(p => ({
      gpRound: p.tagged.generalPlayRoundId,
      tournament: p.tagged.tournamentId ?? null,
      hole: p.tagged.holeNumber,
      shot: p.tagged.shotNumber,
    }));
    expect(sent).toEqual([
      { gpRound: testGeneralPlayRoundId, tournament: null, hole: 5, shot: 1 },
      { gpRound: testGeneralPlayRoundId, tournament: null, hole: 5, shot: 2 },
      { gpRound: testGeneralPlayRoundId, tournament: null, hole: 6, shot: 1 },
    ]);

    const rows = await loadSamples();
    expect(rows.length).toBe(4);

    // Every persisted row must be tagged to the casual round (and never to
    // a tournament).
    for (const r of rows) {
      expect(r.generalPlayRoundId).toBe(testGeneralPlayRoundId);
      expect(r.tournamentId).toBeNull();
      expect(r.round).toBe(1);
    }

    const tagging = rows
      .map(r => ({ hole: r.holeNumber, shot: r.shotNumber, hr: r.hrBpm }))
      .sort((a, b) => (a.hole! - b.hole!) || (a.shot! - b.shot!) || (a.hr - b.hr));

    expect(tagging).toEqual([
      { hole: 5, shot: 1, hr: 96 },
      { hole: 5, shot: 2, hr: 104 },
      { hole: 6, shot: 1, hr: 88 },
      { hole: 6, shot: 1, hr: 90 },
    ]);
  });
});
