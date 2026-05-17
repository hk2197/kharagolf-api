/**
 * Watch heart-rate sampling start/stop — Task #561.
 *
 * Task #431 wired the phone to start/stop the watch HR sampler when the
 * /health-prefs.captureEnabled flag is on, push per-shot context to the
 * watch, and forward inbound batches to POST /api/portal/hr-samples.
 *
 * These tests simulate a round under each toggle state with a mock watch
 * bridge and a fake watch that POSTs sample batches to the real portal HR
 * endpoint. We verify:
 *   1. capture-on at round start triggers sampling and tagged samples
 *      reach /api/portal/hr-samples (and land in hr_samples).
 *   2. capture-off at round start results in no sampling / no POSTs.
 *   3. Toggling capture off mid-round stops sampling and no further
 *      samples are accepted (route refuses with rejected=no_consent).
 *   4. Per-shot/per-hole context tagging is forwarded on each batch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  appUsersTable,
  coursesTable,
  hrSamplesTable,
  organizationsTable,
  playersTable,
  tournamentsTable,
  userHealthPrefsTable,
  db,
} from "@workspace/db";
import {
  _forceExpireHrSessionForTest,
  ingestHrSamples,
  markHrSessionActive,
  markHrSessionEnded,
} from "../lib/wearables.js";
import { createTestApp, type TestUser } from "./helpers.js";

// ── Test fixtures ────────────────────────────────────────────────────
let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;
let testUser: TestUser;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HrSampling_${stamp}`,
    slug: `test-hr-sampling-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "HR Sampling Course",
    slug: `hr-sampling-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `HR Sampling Tournament ${stamp}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `hr-sampling-test-${stamp}`,
    username: `hr_sampling_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    userId: testUserId,
    firstName: "HR",
    lastName: "Tester",
  }).returning({ id: playersTable.id });
  testPlayerId = player.id;

  testUser = { id: testUserId, username: `hr_sampling_test_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(hrSamplesTable).where(eq(hrSamplesTable.userId, testUserId));
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, testUserId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
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
// The phone-side bridge interface mirrors KharagolfWatchBridge's HR
// methods. When `hrStart` is called we record the auth token, base URL,
// and active context; the fake watch then drains pending sample bursts
// and POSTs each batch to /api/portal/hr-samples — exactly what the
// native bridge does on the device. `hrPushContext` updates the tagging
// stamp used on subsequent batches; `hrStop` clears the auth token so
// any further batches the watch tries to send are dropped on the phone
// (mirroring the native behaviour).

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
      // Native bridge merges new fields onto whatever it has stashed.
      context = { ...context, ...ctx };
      calls.hrPushContext += 1;
    },
    /** Simulate the watch delivering a batch of HR samples to the phone. */
    async deliverFromWatch(samples: HrBurst[]) {
      if (!authToken) {
        // Bridge cleared — phone drops the batch on the floor (no POST).
        return;
      }
      // The phone tags each sample with the most-recent context the bridge
      // has been told about, then POSTs the batch to the portal endpoint.
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
    isSampling() {
      return authToken != null;
    },
    /**
     * Simulate the JS process disappearing without a chance to run cleanup
     * effects (OS-level kill / force-quit / crash). The auth token and
     * context stash die with the process so subsequent `deliverFromWatch`
     * calls find no listener — but `hrStop` is intentionally NOT counted,
     * because the unmount cleanup never got a chance to run.
     */
    killProcess() {
      authToken = null;
      baseURL = null;
      context = {};
    },
  };

  return { bridge, calls };
}

// ── Phone orchestrator (mirrors score.tsx HR-capture useEffects) ─────
//
// Encapsulates the same decision logic the score screen runs:
//   - on mount / focus, GET /health-prefs and call hrStart or hrStop
//     based on captureEnabled;
//   - when the active hole/shot changes, push fresh context.

function makePhoneOrchestrator(
  app: ReturnType<typeof createTestApp>,
  bridge: ReturnType<typeof makeMockBridge>["bridge"],
  session: { tournamentId: number; playerId: number; round: number },
) {
  let active = false;
  const state = { holeNumber: 1 as number, shotNumber: 1 as number };

  const buildCtx = (): HrContext => ({
    tournamentId: session.tournamentId,
    playerId:     session.playerId,
    round:        session.round,
    holeNumber:   state.holeNumber,
    shotNumber:   state.shotNumber,
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
    /**
     * Simulate the app process being killed mid-round (OS jetsam, force-quit,
     * crash). Unlike `unmount()`, this never invokes `hrStop` — the cleanup
     * effect doesn't get a chance to run because the JS runtime is gone.
     * The bridge's in-process auth-token stash dies with it, which we model
     * by wiping the bridge state directly without bumping the hrStop counter.
     */
    simulateAppKill() {
      active = false;
      bridge.killProcess();
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
      eq(hrSamplesTable.tournamentId, testTournamentId),
    ));
}

const baseBurst = (offsetMs: number, hrBpm = 92): HrBurst => ({
  hrBpm,
  hrvMs: 42.5,
  stressScore: 30,
  recordedAt: new Date(Date.now() + offsetMs).toISOString(),
});

// ── Tests ────────────────────────────────────────────────────────────

describe("watch HR sampling — capture toggle drives the bridge + portal ingest", () => {
  it("capture-on at round start triggers sampling and tagged samples reach /portal/hr-samples", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
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
      expect(r.tournamentId).toBe(testTournamentId);
      expect(r.playerId).toBe(testPlayerId);
      expect(r.round).toBe(1);
      expect(r.holeNumber).toBe(1);
      expect(r.shotNumber).toBe(1);
      expect(r.source).toBe("apple_watch");
    }

    await orch.unmount();
    expect(calls.hrStop).toBe(1);
    expect(bridge.isSampling()).toBe(false);
  });

  it("capture-off at round start results in no sampling and no POSTs", async () => {
    const app = createTestApp(testUser);
    // Default state for a fresh user is captureEnabled=false; make it explicit.
    await setCaptureEnabled(app, false);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
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

  it("toggling capture off mid-round stops sampling and no further samples are accepted", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
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
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        samples: [{ ...baseBurst(6000, 120), holeNumber: 3, shotNumber: 2, source: "apple_watch" }],
      });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ inserted: 0, rejected: "no_consent" });

    // Only the pre-toggle sample survived in the database.
    const rows = await loadSamples();
    expect(rows.length).toBe(1);
    expect(rows[0].hrBpm).toBe(110);
  });

  it("forwards per-shot/per-hole context tagging on each batch", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
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

    // hrPushContext is called once on each setHole; first setHole(5,1) is
    // a no-op against the existing (5,1) startup context. We don't assert
    // an exact count — what matters is that each delivered batch carries
    // the correct hole/shot stamp, which the rows below confirm.
    expect(calls.hrPushContext).toBeGreaterThanOrEqual(2);
    expect(calls.posts.length).toBe(3);

    // The bridge must have stamped the correct context onto each POST it sent.
    const sent = calls.posts.map(p => ({ hole: p.tagged.holeNumber, shot: p.tagged.shotNumber }));
    expect(sent).toEqual([
      { hole: 5, shot: 1 },
      { hole: 5, shot: 2 },
      { hole: 6, shot: 1 },
    ]);

    const rows = await loadSamples();
    expect(rows.length).toBe(4);

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

  // ── Task #717: round-abandoned paths ───────────────────────────────
  // The score screen's HR useEffect installs a cleanup that calls hrStop
  // on unmount so the watch isn't left burning battery streaming samples
  // with no listener. Task #561 above only covers the explicit toggle-off
  // path. Here we cover the two abandon paths:
  //   (a) clean unmount mid-round (back button / navigation away) with
  //       capture still on → hrStop must fire exactly once and further
  //       watch batches must not reach the portal;
  //   (b) hard process kill mid-round (force-quit / OS jetsam) with
  //       capture still on → cleanup never runs, but the in-process
  //       bridge state dies with the JS runtime, so subsequent watch
  //       batches that try to relay through the dead bridge are dropped
  //       — and any stale POST that does sneak through the moment the
  //       user revokes consent (a likely follow-up action when they
  //       realise the round is gone) is refused with no_consent.

  it("clean unmount mid-round with capture still on calls hrStop exactly once and stops further POSTs", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      round: 1,
    });

    // Round in progress — sampling on, one hole's worth of data through.
    await orch.evaluate();
    await orch.setHole(7, 1);
    await bridge.deliverFromWatch([baseBurst(0, 99)]);
    expect(calls.hrStart).toBe(1);
    expect(calls.posts.length).toBe(1);
    expect(calls.posts[0].status).toBe(200);
    expect(calls.posts[0].body).toMatchObject({ inserted: 1, rejected: null });

    // Player abandons the round — back button / navigates away. The HR
    // useEffect cleanup fires; the consent flag is intentionally NOT
    // touched (the player may resume tomorrow with capture still on).
    await orch.unmount();

    expect(calls.hrStop).toBe(1);
    expect(bridge.isSampling()).toBe(false);

    // Server-side consent is still on — the orchestrator's stop must be
    // the thing protecting battery, not the no_consent guard.
    const prefs = await request(app).get("/api/portal/health-prefs");
    expect(prefs.status).toBe(200);
    expect(prefs.body.hrCaptureEnabled).toBe(true);

    // A second unmount (e.g. React strict-mode double-invoke, or a stray
    // navigation event) must not double-stop the watch.
    await orch.unmount();
    expect(calls.hrStop).toBe(1);

    // Watch keeps streaming — bridge has no auth token, so no POST goes
    // out from the phone. Battery is safe.
    await bridge.deliverFromWatch([baseBurst(2000, 105)]);
    await bridge.deliverFromWatch([baseBurst(4000, 110)]);
    expect(calls.posts.length).toBe(1); // unchanged

    // Only the pre-abandon sample landed in the database.
    const rows = await loadSamples();
    expect(rows.length).toBe(1);
    expect(rows[0].hrBpm).toBe(99);
    expect(rows[0].holeNumber).toBe(7);
  });

  it("hard process kill mid-round refuses stale POSTs at both the bridge and the server even with capture still on", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);
    const orch = makePhoneOrchestrator(app, bridge, {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      round: 1,
    });

    // Round in progress — sampling on, one batch through.
    await orch.evaluate();
    await orch.setHole(11, 1);
    await bridge.deliverFromWatch([baseBurst(0, 102)]);
    expect(calls.hrStart).toBe(1);
    expect(calls.posts.length).toBe(1);
    expect(calls.posts[0].body).toMatchObject({ inserted: 1, rejected: null });

    // OS kills the app process — no clean unmount, no chance to run the
    // cleanup effect. The JS runtime is gone, taking the bridge's auth
    // token with it. We model that by wiping bridge state without
    // bumping the hrStop counter (the cleanup never got a chance to run)
    // and by force-expiring the server-side session as if the TTL had
    // elapsed (the dead phone process can no longer refresh it).
    orch.simulateAppKill();
    await _forceExpireHrSessionForTest(testUserId);

    // hrStop was NEVER invoked — the cleanup didn't get to run. This is
    // the abandoned-round-with-capture-still-on path the task calls out:
    // the consent flag is still on, so no_consent will not save us.
    expect(calls.hrStop).toBe(0);
    expect(bridge.isSampling()).toBe(false);
    const prefs = await request(app).get("/api/portal/health-prefs");
    expect(prefs.body.hrCaptureEnabled).toBe(true);

    // Transport-layer protection: every batch the watch tries to relay
    // through the (now-dead) bridge is dropped because the in-process
    // auth token died with the JS runtime. No POST is even attempted.
    await bridge.deliverFromWatch([baseBurst(2000, 108)]);
    await bridge.deliverFromWatch([baseBurst(4000, 112)]);
    expect(calls.posts.length).toBe(1); // unchanged since the kill

    // Server-layer protection: a stale POST that DID hit the network
    // (e.g. an in-flight HTTP request the watch had queued at the
    // moment of the kill, or a watch that talks to the server directly
    // without bridge mediation) is refused with `session_inactive`,
    // even though the consent flag is still on. This is the explicit
    // refusal the task description calls for, sitting alongside the
    // existing no_consent refusal.
    const stale = await request(app)
      .post("/api/portal/hr-samples")
      .set("Authorization", "Bearer stale-token")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        samples: [{ ...baseBurst(6000, 115), holeNumber: 11, shotNumber: 2, source: "apple_watch" }],
      });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ inserted: 0, rejected: "session_inactive" });

    // Only the pre-kill sample landed in the database — every stale
    // post-kill batch was refused, by either the bridge or the server.
    const rows = await loadSamples();
    expect(rows.length).toBe(1);
    expect(rows[0].hrBpm).toBe(102);
    expect(rows[0].holeNumber).toBe(11);
  });

  // ── Task #1024: native bridge manages the server-side session marker ──
  // The phone-side native bridges (iOS withWatchBridge.js / Wear OS
  // withWatchBridge.js) call POST /api/portal/hr-samples/session on
  // hrStart (action="start") and hrStop (action="end") themselves so any
  // caller that drives the bridge — including paths that don't go
  // through the score-screen useEffect (e.g. a watch reconnect or a
  // phone-wake handler firing hrStart on its own) — keeps the marker in
  // sync with the actual sampling state. The mock bridge in this file
  // already mirrors that behaviour; this test exercises it directly,
  // bypassing the JS-layer orchestrator, to lock in that contract.

  it("native-side hrStart/hrStop without the JS-layer wrap opens and closes the session marker", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);
    const { bridge, calls } = makeMockBridge(app);

    // Native bridge invocation — no orchestrator, no score.tsx useEffect.
    // This models the watch-reconnect / phone-wake path where the native
    // module decides to (re)start sampling on its own.
    await bridge.hrStart("test-bearer-token", "http://localhost", {
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      round: 1,
      holeNumber: 4,
      shotNumber: 1,
    });
    expect(calls.hrStart).toBe(1);
    expect(bridge.isSampling()).toBe(true);

    // Marker is open → ingest accepts the batch (no `session_inactive`).
    await bridge.deliverFromWatch([baseBurst(0, 97)]);
    expect(calls.posts.length).toBe(1);
    expect(calls.posts[0].status).toBe(200);
    expect(calls.posts[0].body).toMatchObject({ inserted: 1, rejected: null });

    // Native bridge stops on its own — must close the marker so any
    // straggler the watch fires after the stop is refused, even though
    // consent is still on.
    await bridge.hrStop();
    expect(calls.hrStop).toBe(1);
    expect(bridge.isSampling()).toBe(false);

    // A late POST that sneaks through the network after the bridge-level
    // stop (e.g. an HTTP request the watch had queued just before the
    // /hr/stop message landed) is refused server-side with
    // `session_inactive` because the marker is closed — even though the
    // consent flag is still on.
    const stale = await request(app)
      .post("/api/portal/hr-samples")
      .set("Authorization", "Bearer test-bearer-token")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        samples: [{ ...baseBurst(2000, 105), holeNumber: 4, shotNumber: 2, source: "apple_watch" }],
      });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ inserted: 0, rejected: "session_inactive" });

    // Only the pre-stop sample survived in the database.
    const rows = await loadSamples();
    expect(rows.length).toBe(1);
    expect(rows[0].hrBpm).toBe(97);
    expect(rows[0].holeNumber).toBe(4);

    // Sanity: consent is still on — the protection here is the marker,
    // not no_consent.
    const prefs = await request(app).get("/api/portal/health-prefs");
    expect(prefs.body.hrCaptureEnabled).toBe(true);
  });

  // ── Task #1025: stop-vs-ingest race must not resurrect a stopped session ──
  // The ingest path used to do a non-atomic check-then-refresh: if an
  // `action=end` POST arrived between the active-session check and the TTL
  // refresh, the refresh would re-create the deleted row and let post-stop
  // straggler samples through. The atomic conditional UPDATE in
  // `refreshHrSessionIfActive` closes that race — once `markHrSessionEnded`
  // has run, the next ingest call must be refused with `session_inactive`.

  it("a sample batch arriving after markHrSessionEnded is refused, not resurrected", async () => {
    const app = createTestApp(testUser);
    await setCaptureEnabled(app, true);

    // Open the session marker as the bridge would on hrStart, then
    // immediately close it as if an `action=end` POST had landed.
    await markHrSessionActive(testUserId);
    await markHrSessionEnded(testUserId);

    // Direct-call ingestHrSamples to model an in-flight batch that has
    // already passed the consent check but is now reaching the
    // active-session guard. Pre-fix this re-upserted the row and
    // returned `inserted: 1`; post-fix it must short-circuit.
    const result = await ingestHrSamples(
      { userId: testUserId, tournamentId: testTournamentId, playerId: testPlayerId, round: 1 },
      [{ hrBpm: 110, recordedAt: new Date().toISOString(), holeNumber: 5, shotNumber: 1 }],
    );
    expect(result).toEqual({ inserted: 0, rejected: "session_inactive" });

    // No row landed in the database, and no zombie session marker was
    // resurrected — a follow-up batch is also refused.
    const rows = await loadSamples();
    expect(rows.length).toBe(0);

    const followUp = await ingestHrSamples(
      { userId: testUserId, tournamentId: testTournamentId, playerId: testPlayerId, round: 1 },
      [{ hrBpm: 112, recordedAt: new Date().toISOString(), holeNumber: 5, shotNumber: 2 }],
    );
    expect(followUp).toEqual({ inserted: 0, rejected: "session_inactive" });
  });
});
