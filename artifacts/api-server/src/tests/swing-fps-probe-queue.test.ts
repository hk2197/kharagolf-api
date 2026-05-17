/**
 * Test: durable swing-video fps probe queue (Task #1217).
 *
 * The queue layer at `src/lib/swingFpsProbeQueue.ts` provides three
 * crash-safety guarantees that this suite exercises end-to-end against
 * the real test database:
 *
 *   1. `enqueueFpsProbe` durably persists a pending probe for every
 *      uploaded swing video, and is idempotent on re-enqueue (unique
 *      index on swing_video_id).
 *   2. `claimNextFpsProbe` uses `FOR UPDATE SKIP LOCKED` so two workers
 *      that poll at the same instant never grab the same probe.
 *   3. `recordFpsProbeFailure` schedules an exponential-backoff retry on
 *      every failure and flips the row to status='failed' once
 *      MAX_FPS_PROBE_ATTEMPTS is reached. `recoverStaleFpsProbing`
 *      re-queues any row that has been stuck in 'probing' past the
 *      stale window — this is what guarantees a swing video uploaded
 *      right before a deploy still gets its fps populated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Suppress the worker's auto-start polling loops and stub out the heavy
// ffprobe call. Both must be hoisted above ESM imports so they take
// effect before `../swingFpsProbeWorker.js` is evaluated.
const { probeMock } = vi.hoisted(() => {
  process.env["SWING_FPS_WORKER_DISABLE_AUTOSTART"] = "1";
  return { probeMock: vi.fn(async (_objectPath: string): Promise<number | null> => null) };
});
vi.mock("../lib/videoFps.js", () => ({
  probeVideoFps: probeMock,
}));

import {
  db,
  swingVideoFpsProbesTable,
  swingVideosTable,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  MAX_FPS_PROBE_ATTEMPTS,
  fpsProbeBackoffSeconds,
  enqueueFpsProbe,
  enqueueLegacyFpsProbes,
  claimNextFpsProbe,
  recordFpsProbeFailure,
  recordFpsProbeSuccess,
  recoverStaleFpsProbing,
} from "../lib/swingFpsProbeQueue.js";
import { processOne } from "../swingFpsProbeWorker.js";

let orgId: number;
let userId: number;
const swingVideoIds: number[] = [];

async function makeSwingVideo(): Promise<{ id: number; objectPath: string }> {
  const objectPath = `/objects/uploads/swing-fps-queue-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [r] = await db.insert(swingVideosTable).values({
    userId,
    organizationId: orgId,
    videoUrl: objectPath,
    view: "dtl",
  }).returning({ id: swingVideosTable.id });
  swingVideoIds.push(r.id);
  return { id: r.id, objectPath };
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `SwingFpsQueueOrg_${ts}`,
    slug: `swing-fps-queue-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `swing-fps-queue-${ts}`,
    username: `swing_fps_queue_${ts}`,
    email: `${ts}@example.test`,
    displayName: "Swing FPS Queue Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  if (swingVideoIds.length > 0) {
    // ON DELETE CASCADE on swing_video_fps_probes.swing_video_id wipes the
    // queue rows automatically.
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, swingVideoIds));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  if (swingVideoIds.length > 0) {
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, swingVideoIds));
    swingVideoIds.length = 0;
  }
  probeMock.mockReset();
  probeMock.mockResolvedValue(null);
});

describe("swing fps probe queue — durable enqueue", () => {
  it("persists a pending probe row that survives the API process restarting", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);

    // Crash-safety contract: the probe is recorded in Postgres BEFORE we
    // would have responded to the upload-completion request. Even after
    // an API restart wipes in-process state, this row is still here
    // waiting for any worker to pick it up.
    const [row] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(row).toBeTruthy();
    expect(row.status).toBe("queued");
    expect(row.objectPath).toBe(objectPath);
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("re-enqueueing the same swing video is a no-op (idempotent on the unique index)", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);

    // Mutate the row so we can detect whether the second enqueue clobbered it.
    await db.update(swingVideoFpsProbesTable)
      .set({ status: "probing", attempts: 3 })
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));

    await enqueueFpsProbe(id, objectPath);

    const rows = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("probing");
    expect(rows[0].attempts).toBe(3);
  });
});

describe("swing fps probe queue — bulk legacy backfill (Task #1411)", () => {
  it("enqueues one probe row per legacy fps=NULL swing video and skips rows whose fps is already set", async () => {
    const a = await makeSwingVideo();
    const b = await makeSwingVideo();
    // `c` has a known fps already → the backfill must not enqueue it.
    const c = await makeSwingVideo();
    await db.update(swingVideosTable).set({ fps: "60" }).where(eq(swingVideosTable.id, c.id));

    const result = await enqueueLegacyFpsProbes();
    // Other test fixtures may also have fps=NULL, so we can't pin the
    // exact totals — but our two freshly-created NULL-fps rows must be
    // among the newly-enqueued ones.
    expect(result.newlyEnqueued).toBeGreaterThanOrEqual(2);
    expect(result.legacyCount).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [a.id, b.id, c.id]));
    const byVideo = new Map(rows.map(r => [r.swingVideoId, r]));

    // Both NULL-fps rows are now in the queue, ready to be claimed by
    // the standalone worker with attempts=0 and status='queued'.
    const probeA = byVideo.get(a.id);
    const probeB = byVideo.get(b.id);
    expect(probeA).toBeTruthy();
    expect(probeA!.status).toBe("queued");
    expect(probeA!.attempts).toBe(0);
    expect(probeA!.objectPath).toBe(a.objectPath);
    expect(probeA!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(probeB).toBeTruthy();
    expect(probeB!.status).toBe("queued");

    // The fps-already-known row is NOT enqueued — the worker would have
    // nothing to do with it and we'd just churn ffprobe for nothing.
    expect(byVideo.get(c.id)).toBeUndefined();
  });

  it("re-running is a no-op for already-queued rows: ON CONFLICT DO NOTHING preserves status/attempts/error", async () => {
    const a = await makeSwingVideo();
    await enqueueLegacyFpsProbes();

    // Simulate the worker having already taken several swings at this
    // probe and given up. The legacy swing_videos row is still fps=NULL
    // because we only flipped the probe to 'failed' — the script must
    // NOT clobber that hard-won state on a rerun.
    await db.update(swingVideoFpsProbesTable)
      .set({ status: "failed", attempts: 4, errorMessage: "previous run" })
      .where(eq(swingVideoFpsProbesTable.swingVideoId, a.id));

    await enqueueLegacyFpsProbes();

    const [row] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, a.id));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(4);
    expect(row.errorMessage).toBe("previous run");
  });

  it("never runs ffprobe inline — all probing is deferred to the worker", async () => {
    await makeSwingVideo();
    await makeSwingVideo();
    probeMock.mockClear();
    await enqueueLegacyFpsProbes();
    // The whole point of Task #1411 is that the script becomes a fast
    // DML statement; if it ever calls probeVideoFps we've regressed.
    expect(probeMock).not.toHaveBeenCalled();
  });
});

describe("swing fps probe queue — concurrent claim safety", () => {
  it("two parallel claims never return the same probe id (FOR UPDATE SKIP LOCKED)", async () => {
    const a = await makeSwingVideo();
    const b = await makeSwingVideo();
    await enqueueFpsProbe(a.id, a.objectPath);
    await enqueueFpsProbe(b.id, b.objectPath);

    const [c1, c2] = await Promise.all([claimNextFpsProbe(), claimNextFpsProbe()]);
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1!.id).not.toBe(c2!.id);
    expect(new Set([c1!.swingVideoId, c2!.swingVideoId])).toEqual(new Set([a.id, b.id]));

    // A third claim with no remaining work returns null.
    expect(await claimNextFpsProbe()).toBeNull();

    const rows = await db.select().from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [a.id, b.id]));
    for (const row of rows) {
      expect(row.status).toBe("probing");
      expect(row.attempts).toBe(1);
      expect(row.startedAt).not.toBeNull();
    }
  });

  it("skips rows whose next_attempt_at is in the future", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);
    await db.update(swingVideoFpsProbesTable)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(await claimNextFpsProbe()).toBeNull();
  });
});

describe("swing fps probe queue — retry with exponential backoff", () => {
  it("schedules a backoff retry on each failure and marks failed once the cap is reached", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);

    for (let attempt = 1; attempt <= MAX_FPS_PROBE_ATTEMPTS; attempt++) {
      // Make sure the row is eligible for the next claim.
      await db.update(swingVideoFpsProbesTable)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(swingVideoFpsProbesTable.swingVideoId, id));

      const claimed = await claimNextFpsProbe();
      expect(claimed).not.toBeNull();
      expect(claimed!.swingVideoId).toBe(id);
      expect(claimed!.attempts).toBe(attempt);

      const before = Date.now();
      await recordFpsProbeFailure(claimed!.id, `boom ${attempt}`);
      const [row] = await db.select().from(swingVideoFpsProbesTable)
        .where(eq(swingVideoFpsProbesTable.id, claimed!.id));

      if (attempt < MAX_FPS_PROBE_ATTEMPTS) {
        expect(row.status).toBe("queued");
        expect(row.errorMessage).toBe(`boom ${attempt}`);
        const expectedDelayMs = fpsProbeBackoffSeconds(attempt) * 1000;
        const actualDelayMs = row.nextAttemptAt.getTime() - before;
        // ±2s for clock + DB round-trip jitter.
        expect(actualDelayMs).toBeGreaterThanOrEqual(expectedDelayMs - 2_000);
        expect(actualDelayMs).toBeLessThanOrEqual(expectedDelayMs + 2_000);
      } else {
        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(`boom ${attempt}`);
        expect(row.completedAt).not.toBeNull();
      }
      expect(row.attempts).toBe(attempt);
    }

    // Sanity: a failed row is no longer claimable, even with a past
    // next_attempt_at, because the status filter excludes it.
    await db.update(swingVideoFpsProbesTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(await claimNextFpsProbe()).toBeNull();
  });

  it("truncates very long error messages to 500 chars before persisting", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);
    const claimed = await claimNextFpsProbe();
    await recordFpsProbeFailure(claimed!.id, "x".repeat(2000));
    const [row] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.id, claimed!.id));
    expect(row.errorMessage?.length).toBe(500);
  });
});

describe("swing fps probe queue — success persists fps onto swing_videos", () => {
  it("recordFpsProbeSuccess writes the fps to swing_videos and marks the probe done", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);
    const claimed = await claimNextFpsProbe();

    await recordFpsProbeSuccess(claimed!.id, claimed!.swingVideoId, 59.94);

    const [video] = await db.select().from(swingVideosTable)
      .where(eq(swingVideosTable.id, id));
    expect(Number(video.fps)).toBeCloseTo(59.94, 3);

    const [probe] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.id, claimed!.id));
    expect(probe.status).toBe("done");
    expect(probe.completedAt).not.toBeNull();
    expect(probe.errorMessage).toBeNull();
  });
});

describe("swing fps probe worker — error wiring", () => {
  it("catches a thrown probe error and schedules a backoff retry instead of crashing", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);

    probeMock.mockImplementationOnce(async () => { throw new Error("simulated ffprobe crash"); });
    expect(await processOne()).toBe(true);

    const [afterFailure] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(afterFailure.status).toBe("queued");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.errorMessage).toBe("simulated ffprobe crash");
    expect(afterFailure.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Second pass: probe succeeds → swing_videos.fps is populated and the
    // probe row flips to 'done'.
    await db.update(swingVideoFpsProbesTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    probeMock.mockResolvedValueOnce(120);
    expect(await processOne()).toBe(true);

    const [video] = await db.select().from(swingVideosTable)
      .where(eq(swingVideosTable.id, id));
    expect(Number(video.fps)).toBe(120);
    const [afterSuccess] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    expect(afterSuccess.status).toBe("done");

    // Nothing left to claim.
    expect(await processOne()).toBe(false);
  });

  it("treats a null ffprobe result (unverifiable rate) as a retryable failure", async () => {
    const { id, objectPath } = await makeSwingVideo();
    await enqueueFpsProbe(id, objectPath);
    probeMock.mockResolvedValueOnce(null);

    expect(await processOne()).toBe(true);
    const [row] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, id));
    // Not a permanent failure on first attempt — this is what gives a
    // transiently-missing storage object a chance to recover.
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.errorMessage).toMatch(/no usable frame rate/i);
    const [video] = await db.select().from(swingVideosTable).where(eq(swingVideosTable.id, id));
    expect(video.fps).toBeNull();
  });
});

describe("swing fps probe queue — stale probe recovery", () => {
  it("re-queues rows stuck in 'probing' past the stale window", async () => {
    // Simulate a worker that claimed a probe and then crashed. This is
    // the precise scenario Task #1217 was filed to fix: an API/worker
    // restart between claim and ffprobe completion would otherwise
    // strand the swing video at fps=NULL forever.
    const stuckLongAgo = await makeSwingVideo();
    await enqueueFpsProbe(stuckLongAgo.id, stuckLongAgo.objectPath);
    await db.update(swingVideoFpsProbesTable).set({
      status: "probing",
      attempts: 1,
      startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    }).where(eq(swingVideoFpsProbesTable.swingVideoId, stuckLongAgo.id));

    // A second, fresh in-flight probe that should NOT be touched.
    const freshlyProbing = await makeSwingVideo();
    await enqueueFpsProbe(freshlyProbing.id, freshlyProbing.objectPath);
    await db.update(swingVideoFpsProbesTable).set({
      status: "probing",
      attempts: 1,
      startedAt: new Date(Date.now() - 30 * 1000), // 30s ago
    }).where(eq(swingVideoFpsProbesTable.swingVideoId, freshlyProbing.id));

    const recovered = await recoverStaleFpsProbing(5 * 60);
    expect(recovered).toBe(1);

    const [stuck] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, stuckLongAgo.id));
    expect(stuck.status).toBe("queued");
    expect(stuck.errorMessage).toMatch(/Worker crashed/i);
    expect(stuck.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const [fresh] = await db.select().from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, freshlyProbing.id));
    expect(fresh.status).toBe("probing");

    // After recovery the requeued probe can be picked up by a worker.
    const claimed = await claimNextFpsProbe();
    expect(claimed!.swingVideoId).toBe(stuckLongAgo.id);
  });
});
