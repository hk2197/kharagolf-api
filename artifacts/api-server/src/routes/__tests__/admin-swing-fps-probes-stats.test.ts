/**
 * Task #1709 — GET /api/admin/swing-fps-probes/stats.
 *
 * Pins the contract on the new admin diagnostics endpoint that surfaces
 * the durable swing-fps probe queue's state. After Task #1411 made
 * `backfill:swing-video-fps` a one-shot enqueue, ops needed a way to
 * confirm the standalone worker had drained the queue without dropping
 * into psql for ad-hoc `GROUP BY status` counts on
 * `swing_video_fps_probes`. This suite covers:
 *   • 401 when unauthenticated.
 *   • 403 for non-admin roles (player).
 *   • Admin sees `byStatus` with all four enum values present (zeroed
 *     when no rows exist for that status), the `total`, and the oldest
 *     `queued.next_attempt_at`.
 *   • Probes in non-queued statuses are excluded from
 *     `oldestQueuedNextAttemptAt` even when their next_attempt_at is
 *     older than any queued row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  swingVideosTable,
  swingVideoFpsProbesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "../../tests/helpers.js";

let orgId: number;
let adminUser: TestUser;
let playerUser: TestUser;
const swingVideoIds: number[] = [];

async function makeSwingVideo(): Promise<number> {
  const objectPath = `/objects/uploads/admin-fps-stats-${uid()}`;
  const [r] = await db.insert(swingVideosTable).values({
    userId: adminUser.id,
    organizationId: orgId,
    videoUrl: objectPath,
    view: "dtl",
  }).returning({ id: swingVideosTable.id });
  swingVideoIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const ts = uid("admin_fps_stats");
  const [org] = await db.insert(organizationsTable).values({
    name: `AdminFpsStatsOrg_${ts}`,
    slug: `admin-fps-stats-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `admin-fps-stats-admin-${ts}`,
    username: `admin_fps_stats_admin_${ts}`,
    email: `${ts}_admin@example.test`,
    displayName: "Admin FPS Stats Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUser = { id: admin.id, username: `admin_fps_stats_admin_${ts}`, role: "org_admin", organizationId: orgId };

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `admin-fps-stats-player-${ts}`,
    username: `admin_fps_stats_player_${ts}`,
    email: `${ts}_player@example.test`,
    displayName: "Admin FPS Stats Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerUser = { id: player.id, username: `admin_fps_stats_player_${ts}`, role: "player", organizationId: orgId };
});

afterAll(async () => {
  if (swingVideoIds.length > 0) {
    // ON DELETE CASCADE on swing_video_fps_probes.swing_video_id wipes
    // the queue rows automatically.
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, swingVideoIds));
  }
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminUser.id, playerUser.id]));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Each test seeds its own probe rows; reset the swing_videos this
  // suite owns (cascade clears their probe rows) so counts are
  // deterministic regardless of order.
  if (swingVideoIds.length > 0) {
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, swingVideoIds));
    swingVideoIds.length = 0;
  }
});

describe("GET /api/admin/swing-fps-probes/stats", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/swing-fps-probes/stats");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerUser);
    const res = await request(app).get("/api/admin/swing-fps-probes/stats");
    expect(res.status).toBe(403);
  });

  it("returns counts grouped by status with every enum value present", async () => {
    // Seed one row per status so we exercise the byStatus shape end-to-end.
    const queuedAt = new Date(Date.now() - 60 * 1000);
    const olderQueuedAt = new Date(Date.now() - 30 * 60 * 1000);
    const probingStartedAt = new Date(Date.now() - 5 * 60 * 1000);

    const queuedVideoId = await makeSwingVideo();
    const olderQueuedVideoId = await makeSwingVideo();
    const probingVideoId = await makeSwingVideo();
    const doneVideoId = await makeSwingVideo();
    const failedVideoId = await makeSwingVideo();

    await db.insert(swingVideoFpsProbesTable).values([
      {
        swingVideoId: queuedVideoId,
        objectPath: `/objects/uploads/queued-${queuedVideoId}`,
        status: "queued",
        attempts: 0,
        nextAttemptAt: queuedAt,
      },
      {
        swingVideoId: olderQueuedVideoId,
        objectPath: `/objects/uploads/older-queued-${olderQueuedVideoId}`,
        status: "queued",
        attempts: 1,
        nextAttemptAt: olderQueuedAt,
      },
      {
        swingVideoId: probingVideoId,
        objectPath: `/objects/uploads/probing-${probingVideoId}`,
        status: "probing",
        attempts: 1,
        // Far older than any queued row; must NOT appear in
        // oldestQueuedNextAttemptAt because it's mid-probe, not waiting.
        nextAttemptAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
        startedAt: probingStartedAt,
      },
      {
        swingVideoId: doneVideoId,
        objectPath: `/objects/uploads/done-${doneVideoId}`,
        status: "done",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
        completedAt: new Date(),
      },
      {
        swingVideoId: failedVideoId,
        objectPath: `/objects/uploads/failed-${failedVideoId}`,
        status: "failed",
        attempts: 5,
        nextAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
        errorMessage: "ffprobe gave up",
        completedAt: new Date(),
      },
    ]);

    const app = createTestApp(adminUser);
    const res = await request(app).get("/api/admin/swing-fps-probes/stats");
    expect(res.status).toBe(200);

    // Shape contract: every enum status is present (zero-filled for
    // statuses with no rows on a fresh deploy) so dashboards don't have
    // to special-case missing keys.
    expect(res.body.byStatus).toMatchObject({
      queued: expect.any(Number),
      probing: expect.any(Number),
      done: expect.any(Number),
      failed: expect.any(Number),
    });

    // The suite tears down between tests, so the only rows visible are
    // the ones we just inserted. Other suites may insert their own
    // rows in parallel — we can't assert exact totals without
    // serializing the entire test runner — so we use >= comparisons
    // instead, which still proves the endpoint counts our seeded rows.
    expect(res.body.byStatus.queued).toBeGreaterThanOrEqual(2);
    expect(res.body.byStatus.probing).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus.done).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus.failed).toBeGreaterThanOrEqual(1);

    expect(res.body.total).toBe(
      res.body.byStatus.queued +
        res.body.byStatus.probing +
        res.body.byStatus.done +
        res.body.byStatus.failed,
    );

    // The older queued row's next_attempt_at is the oldest among the
    // queued rows we seeded, so the endpoint's value must be at least
    // as old as it. This is the value that tells operators how long
    // the queue has been stuck. Other suites running against the same
    // shared DB might have queued rows that are even older, so we
    // can't use equality — only an upper bound.
    expect(res.body.oldestQueuedNextAttemptAt).not.toBeNull();
    const oldest = new Date(res.body.oldestQueuedNextAttemptAt as string).getTime();
    expect(oldest).toBeLessThanOrEqual(olderQueuedAt.getTime() + 1);
    // And critically, the probing row (with `next_attempt_at` set
    // 10h in the past, deliberately older than its `started_at`) must
    // NOT have leaked through. We assert this by checking that the
    // returned timestamp is strictly newer than the probing row's
    // `next_attempt_at`, regardless of what other suites have queued.
    const probingNextAttempt = Date.now() - 10 * 60 * 60 * 1000;
    expect(oldest).toBeGreaterThan(probingNextAttempt);
  });
});
