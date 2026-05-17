/**
 * Test: scheduled retention sweep for swing_video_fps_probes (Task #1412).
 *
 * Task #1217 made the fps probe queue durable: every uploaded swing video
 * gets exactly one row keyed by `swing_video_id`. After a probe finishes
 * (`done`/`failed`) the row stays so a re-enqueue is a no-op against the
 * unique index — but with no cleanup the table grows forever as more
 * videos are uploaded. `sweepOldFpsProbes` deletes `done` rows older than
 * the retention window and intentionally retains `failed` rows so
 * persistent failures stay visible to operators.
 *
 * This suite asserts:
 *   1. `done` rows older than the retention window are deleted.
 *   2. `done` rows still inside the window are kept.
 *   3. `failed` rows are NEVER deleted by the sweep, regardless of age.
 *   4. `queued` / `probing` rows are never touched.
 *   5. The sweep returns the count of removed rows and a separate
 *      count of remaining `failed` rows so cron logging / future ops
 *      alerts can surface a growing failure backlog cheaply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress the worker's auto-start polling loop. The retention sweep is
// independent of the worker, but `swingFpsProbeQueue` is imported by the
// worker module and we don't want a stray polling loop racing the test
// state.
vi.hoisted(() => {
  process.env["SWING_FPS_WORKER_DISABLE_AUTOSTART"] = "1";
});

import {
  appUsersTable,
  db,
  organizationsTable,
  swingVideoFpsProbesTable,
  swingVideosTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  FPS_PROBE_DONE_RETENTION_DAYS,
  sweepOldFpsProbes,
} from "../lib/swingFpsProbeQueue.js";

let orgId: number;
let userId: number;
const swingVideoIds: number[] = [];

async function makeSwingVideo(): Promise<number> {
  const [r] = await db.insert(swingVideosTable).values({
    userId,
    organizationId: orgId,
    videoUrl: `/objects/uploads/swing-fps-retention-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    view: "dtl",
  }).returning({ id: swingVideosTable.id });
  swingVideoIds.push(r.id);
  return r.id;
}

async function insertProbe(opts: {
  swingVideoId: number;
  status: "queued" | "probing" | "done" | "failed";
  completedAt: Date | null;
  startedAt?: Date | null;
}): Promise<number> {
  const [row] = await db.insert(swingVideoFpsProbesTable).values({
    swingVideoId: opts.swingVideoId,
    objectPath: `/objects/uploads/swing-fps-retention-${opts.swingVideoId}`,
    status: opts.status,
    attempts: opts.status === "queued" ? 0 : 1,
    nextAttemptAt: new Date(),
    startedAt: opts.startedAt ?? (opts.status === "queued" ? null : new Date()),
    completedAt: opts.completedAt,
  }).returning({ id: swingVideoFpsProbesTable.id });
  return row.id;
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `SwingFpsRetentionOrg_${ts}`,
    slug: `swing-fps-retention-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `swing-fps-retention-${ts}`,
    username: `swing_fps_retention_${ts}`,
    email: `${ts}@example.test`,
    displayName: "Swing FPS Retention Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  if (swingVideoIds.length > 0) {
    // ON DELETE CASCADE wipes the queue rows.
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
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sweepOldFpsProbes (Task #1412)", () => {
  it("deletes done rows older than the default 30-day retention window", async () => {
    const videoOld = await makeSwingVideo();
    const videoFresh = await makeSwingVideo();

    // Done 60 days ago — well past the 30-day window.
    await insertProbe({
      swingVideoId: videoOld,
      status: "done",
      completedAt: new Date(Date.now() - 60 * DAY_MS),
    });
    // Done 5 days ago — comfortably inside the window.
    await insertProbe({
      swingVideoId: videoFresh,
      status: "done",
      completedAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const result = await sweepOldFpsProbes();

    expect(result.removedDone).toBe(1);
    expect(result.failedRetained).toBe(0);

    const remaining = await db.select()
      .from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [videoOld, videoFresh]));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].swingVideoId).toBe(videoFresh);
  });

  it("retains failed rows regardless of age so persistent failures stay visible", async () => {
    const videoFailedOld = await makeSwingVideo();
    const videoFailedAncient = await makeSwingVideo();

    // Both failed long after the retention window — still must NOT be deleted.
    await insertProbe({
      swingVideoId: videoFailedOld,
      status: "failed",
      completedAt: new Date(Date.now() - 45 * DAY_MS),
    });
    await insertProbe({
      swingVideoId: videoFailedAncient,
      status: "failed",
      completedAt: new Date(Date.now() - 365 * DAY_MS),
    });

    const result = await sweepOldFpsProbes();

    expect(result.removedDone).toBe(0);
    expect(result.failedRetained).toBeGreaterThanOrEqual(2);

    const remaining = await db.select()
      .from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [videoFailedOld, videoFailedAncient]));
    expect(remaining).toHaveLength(2);
    for (const row of remaining) expect(row.status).toBe("failed");
  });

  it("never touches queued or probing rows even if startedAt is ancient", async () => {
    const videoQueued = await makeSwingVideo();
    const videoProbing = await makeSwingVideo();

    await insertProbe({
      swingVideoId: videoQueued,
      status: "queued",
      completedAt: null,
    });
    // Crashed worker — startedAt is ancient but the row hasn't reached
    // a terminal state. The stale-probe recovery job handles this; the
    // retention sweep must not.
    await insertProbe({
      swingVideoId: videoProbing,
      status: "probing",
      startedAt: new Date(Date.now() - 90 * DAY_MS),
      completedAt: null,
    });

    const result = await sweepOldFpsProbes();

    expect(result.removedDone).toBe(0);
    const remaining = await db.select()
      .from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [videoQueued, videoProbing]));
    expect(remaining).toHaveLength(2);
    expect(remaining.find(r => r.swingVideoId === videoQueued)?.status).toBe("queued");
    expect(remaining.find(r => r.swingVideoId === videoProbing)?.status).toBe("probing");
  });

  it("respects a custom retention window (used by tests / future tuning)", async () => {
    const videoTwoDays = await makeSwingVideo();
    const videoTenDays = await makeSwingVideo();

    await insertProbe({
      swingVideoId: videoTwoDays,
      status: "done",
      completedAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await insertProbe({
      swingVideoId: videoTenDays,
      status: "done",
      completedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    // 7-day window: the 10-day-old row goes, the 2-day-old row stays.
    const result = await sweepOldFpsProbes(7);

    expect(result.removedDone).toBe(1);

    const remaining = await db.select()
      .from(swingVideoFpsProbesTable)
      .where(inArray(swingVideoFpsProbesTable.swingVideoId, [videoTwoDays, videoTenDays]));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].swingVideoId).toBe(videoTwoDays);
  });

  it("is a no-op when nothing is over the retention window", async () => {
    const videoFresh = await makeSwingVideo();
    await insertProbe({
      swingVideoId: videoFresh,
      status: "done",
      completedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    const result = await sweepOldFpsProbes();

    expect(result.removedDone).toBe(0);
    const [row] = await db.select()
      .from(swingVideoFpsProbesTable)
      .where(eq(swingVideoFpsProbesTable.swingVideoId, videoFresh));
    expect(row.status).toBe("done");
  });

  it("exports a sane default retention constant (~weeks, not days)", () => {
    expect(FPS_PROBE_DONE_RETENTION_DAYS).toBeGreaterThanOrEqual(14);
    expect(FPS_PROBE_DONE_RETENTION_DAYS).toBeLessThanOrEqual(180);
  });
});
