/**
 * Tests for Task #1704 — auto-page on-call when the swing-video
 * fps-probe failure backlog crosses a threshold OR grows materially
 * since the last run.
 *
 * Covers:
 *   - Failed count below threshold AND no recent growth → no email.
 *   - Failed count at/above threshold → emails super-admins + on-call,
 *     each with the recent-failures sample (swing_video_id +
 *     error_message) embedded.
 *   - Growth trigger: count of `failed` rows whose `updated_at` lands
 *     inside the lookback window crosses the growth delta — pages even
 *     when the absolute count is below the threshold.
 *   - Both triggers firing simultaneously → exactly one email, with
 *     both flags reflected in `trigger`.
 *   - Cooldown suppresses repeat pages within the cooldown window;
 *     `force` overrides. Cooldown applies regardless of which trigger
 *     fired.
 *   - No recipients (no super_admin email AND OPS_ALERT_EMAILS unset)
 *     returns `no_recipients` instead of throwing.
 *   - Recent-failures loader returns the most-recently-updated `failed`
 *     rows, capped to the requested sample size, ignoring non-failed
 *     statuses.
 *   - Growth-count loader queries `failed` rows whose `updated_at` is
 *     inside the lookback window (stateless, no persisted last-run
 *     counter required).
 *   - Reads recipient list from DB super_admins + OPS_ALERT_EMAILS env
 *     when no explicit recipients are passed (deduped case-insensitively).
 *   - Threshold + cooldown + sample size + growth delta + growth
 *     lookback hours pull from env when not overridden.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(() => {
  process.env["SWING_FPS_WORKER_DISABLE_AUTOSTART"] = "1";
});

vi.mock("../lib/mailer.js", async () => ({
  sendSwingFpsProbeFailureOpsAlertEmail: vi.fn(async () => undefined),
}));

import {
  appUsersTable,
  db,
  organizationsTable,
  swingVideoFpsProbesTable,
  swingVideosTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  runFpsProbeFailureOpsAlertJob,
  loadRecentFpsProbeFailures,
  loadFpsProbeFailureGrowthCount,
  _resetFpsProbeFailureOpsAlertDedupForTest,
  DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD,
  DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS,
  DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS,
  type FpsProbeFailureSample,
} from "../lib/swingFpsProbeFailureOpsAlert.js";
import { sendSwingFpsProbeFailureOpsAlertEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendSwingFpsProbeFailureOpsAlertEmail);

let testSuperAdminId: number | null = null;
let testSuperAdminEmail: string | null = null;
let testOrgId: number | null = null;
let testUserId: number | null = null;
const seededVideoIds: number[] = [];

async function seedFailedRows(count: number, opts?: { errorPrefix?: string }): Promise<number[]> {
  const ids: number[] = [];
  const prefix = opts?.errorPrefix ?? "ffprobe failed";
  // Insert sequentially so each row's `updated_at` (defaulted to now())
  // is monotonically increasing — lets the loader test assert ordering.
  for (let i = 0; i < count; i++) {
    const [v] = await db.insert(swingVideosTable).values({
      userId: testUserId!,
      organizationId: testOrgId!,
      videoUrl: `/objects/uploads/swing-fps-failure-${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      view: "dtl",
    }).returning({ id: swingVideosTable.id });
    seededVideoIds.push(v.id);
    await db.insert(swingVideoFpsProbesTable).values({
      swingVideoId: v.id,
      objectPath: `/objects/uploads/swing-fps-failure-${v.id}`,
      status: "failed",
      attempts: 5,
      nextAttemptAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: `${prefix} #${i}`,
    });
    ids.push(v.id);
    // Tiny stagger so updated_at differs row-to-row across all DBs;
    // some Postgres builds collapse same-millisecond writes when read
    // back, which would make the ORDER BY non-deterministic.
    await new Promise((r) => setTimeout(r, 5));
  }
  return ids;
}

async function clearAllSeededRows(): Promise<void> {
  if (seededVideoIds.length > 0) {
    await db.delete(swingVideosTable).where(inArray(swingVideosTable.id, seededVideoIds));
    seededVideoIds.length = 0;
  }
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  testSuperAdminEmail = `fps_failure_admin_${stamp}@example.com`;
  const [org] = await db.insert(organizationsTable).values({
    name: `FpsFailureOrg_${stamp}`,
    slug: `fps-failure-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `fps-failure-admin-${stamp}`,
    username: `fps_failure_admin_${stamp}`,
    email: testSuperAdminEmail,
    role: "super_admin",
    organizationId: org.id,
  }).returning({ id: appUsersTable.id });
  testSuperAdminId = admin.id;
  // Separate non-super-admin user for the swing_videos.user_id FK so
  // the helper rows look like real uploads.
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `fps-failure-user-${stamp}`,
    username: `fps_failure_user_${stamp}`,
    email: `fps_failure_user_${stamp}@example.test`,
    role: "player",
    organizationId: org.id,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  await clearAllSeededRows();
  if (testSuperAdminId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testSuperAdminId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  _resetFpsProbeFailureOpsAlertDedupForTest();
  await clearAllSeededRows();
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
  delete process.env.OPS_FPS_PROBE_FAILED_THRESHOLD;
  delete process.env.OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS;
  delete process.env.OPS_FPS_PROBE_FAILED_SAMPLE_SIZE;
});

describe("runFpsProbeFailureOpsAlertJob — below threshold", () => {
  it("does not page when failedRetained is below threshold and growth is below delta", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 0,
      failedRetained: 24,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("below_threshold");
    expect(res.trigger).toEqual({ thresholdBreached: false, growthBreached: false });
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runFpsProbeFailureOpsAlertJob — at/above threshold", () => {
  it("emails super-admins + on-call (deduped) and embeds the recent-failures sample", async () => {
    process.env.OPS_ALERT_EMAILS = `oncall@example.com, ops@example.com, ${testSuperAdminEmail!.toUpperCase()}`;
    const sample: FpsProbeFailureSample[] = [
      { swingVideoId: 1001, completedAt: "2026-04-29T12:00:00.000Z", errorMessage: "ffprobe exited 1" },
      { swingVideoId: 1002, completedAt: "2026-04-29T11:50:00.000Z", errorMessage: "object not found" },
    ];

    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 10,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 30,
      recentFailuresOverride: sample,
      now: new Date("2026-04-29T12:00:00Z"),
    });

    expect(res.alerted).toBe(true);
    expect(res.trigger).toEqual({ thresholdBreached: true, growthBreached: false });
    // 1 DB super-admin + 2 on-call addresses, with the env's
    // UPPERCASE duplicate of the super-admin email collapsed.
    expect(res.recipientsAttempted).toBe(3);
    expect(res.recipientsEmailed).toBe(3);
    expect(emailMock).toHaveBeenCalledTimes(3);
    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/swing-video-diagnostics$/);
    expect(firstCall.failedRetained).toBe(30);
    expect(firstCall.threshold).toBe(25);
    expect(firstCall.cooldownHours).toBe(24);
    expect(firstCall.growthCount).toBe(0);
    expect(firstCall.growthDelta).toBe(1000);
    expect(firstCall.trigger).toEqual({ thresholdBreached: true, growthBreached: false });
    expect(firstCall.recentFailures).toEqual(sample);
  });

  it("alerts at exactly the threshold (>= comparison, not >)", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 25,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.trigger.thresholdBreached).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit recipients override (no super-admin / env lookup) and dedups case-insensitively", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 100,
      recipients: ["only@example.com", "Only@Example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsEmailed).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});

describe("runFpsProbeFailureOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");

    const first = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 30,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 1h later — still well inside the 24h cooldown.
    const second = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 30,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Force override re-pages even inside the cooldown.
    const forced = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 30,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: new Date(t0.getTime() + 2 * 60 * 60 * 1000),
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);

    // After the cooldown elapses (relative to the forced page at t0+2h),
    // the next natural tick re-pages.
    const fourth = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 30,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: new Date(t0.getTime() + 27 * 60 * 60 * 1000),
    });
    expect(fourth.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
  });
});

describe("runFpsProbeFailureOpsAlertJob — growth trigger", () => {
  it("pages on growth even when failedRetained is well below the absolute threshold", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 12, // 12 new failures in lookback window
      failedRetained: 12,      // still below absolute threshold
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.trigger).toEqual({ thresholdBreached: false, growthBreached: true });
    expect(res.growthCount).toBe(12);
    expect(res.growthDelta).toBe(10);
    expect(emailMock).toHaveBeenCalledTimes(1);
    const call = emailMock.mock.calls[0][0];
    expect(call.trigger).toEqual({ thresholdBreached: false, growthBreached: true });
    expect(call.growthCount).toBe(12);
  });

  it("alerts at exactly the growth delta (>= comparison, not >)", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 10,
      failedRetained: 10,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.trigger.growthBreached).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("flags both triggers when threshold and growth fire on the same run, but only sends one email", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 15,
      failedRetained: 40,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.trigger).toEqual({ thresholdBreached: true, growthBreached: true });
    // Both triggers active, but exactly one outbound email.
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].trigger).toEqual({
      thresholdBreached: true,
      growthBreached: true,
    });
  });

  it("does not page when growth equals delta - 1 and the absolute threshold is also not reached", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 9,
      failedRetained: 9,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("below_threshold");
    expect(res.trigger).toEqual({ thresholdBreached: false, growthBreached: false });
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("cooldown applies to growth-only triggers too — sustained-growth backlog still pages at most once per cooldown", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");

    const first = await runFpsProbeFailureOpsAlertJob({
      threshold: 999,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 15,
      failedRetained: 15,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(first.trigger).toEqual({ thresholdBreached: false, growthBreached: true });

    const second = await runFpsProbeFailureOpsAlertJob({
      threshold: 999,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthCountOverride: 20,
      failedRetained: 35,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});

describe("runFpsProbeFailureOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when neither super-admins nor OPS_ALERT_EMAILS provide an address", async () => {
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 1000,
      growthCountOverride: 0,
      failedRetained: 100,
      recipients: [],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runFpsProbeFailureOpsAlertJob — env-driven defaults", () => {
  it("threshold + cooldown + sample size + growth tunables fall back to env vars when unset", async () => {
    process.env.OPS_FPS_PROBE_FAILED_THRESHOLD = "3";
    process.env.OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS = "12";
    process.env.OPS_FPS_PROBE_FAILED_SAMPLE_SIZE = "2";
    process.env.OPS_FPS_PROBE_FAILED_GROWTH_DELTA = "7";
    process.env.OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS = "6";

    const res = await runFpsProbeFailureOpsAlertJob({
      failedRetained: 4, // below default 25, but at/above env-set 3
      growthCountOverride: 0,
      recipients: ["ops@example.com"],
      recentFailuresOverride: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.threshold).toBe(3);
    expect(res.cooldownHours).toBe(12);
    expect(res.sampleSize).toBe(2);
    expect(res.growthDelta).toBe(7);
    expect(res.growthLookbackHours).toBe(6);
  });

  it("exposes sane hardcoded defaults when no overrides at all", () => {
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD).toBeLessThanOrEqual(200);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS).toBeLessThanOrEqual(168);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE).toBeLessThanOrEqual(50);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA).toBeLessThanOrEqual(
      DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD,
    );
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS).toBeLessThanOrEqual(168);
  });
});

describe("loadRecentFpsProbeFailures", () => {
  it("returns the most-recently-updated failed rows up to the requested sample size, ignoring non-failed statuses", async () => {
    // Seed 3 failed rows (oldest → newest by updated_at) plus one
    // 'done' row that should never appear in the result.
    const failedIds = await seedFailedRows(3, { errorPrefix: "ffprobe oops" });
    const [doneVideo] = await db.insert(swingVideosTable).values({
      userId: testUserId!,
      organizationId: testOrgId!,
      videoUrl: `/objects/uploads/swing-fps-failure-done-${Date.now()}`,
      view: "dtl",
    }).returning({ id: swingVideosTable.id });
    seededVideoIds.push(doneVideo.id);
    await db.insert(swingVideoFpsProbesTable).values({
      swingVideoId: doneVideo.id,
      objectPath: `/objects/uploads/swing-fps-failure-done-${doneVideo.id}`,
      status: "done",
      attempts: 1,
      nextAttemptAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await loadRecentFpsProbeFailures(2);
    expect(result).toHaveLength(2);
    // Every returned row must be one of the seeded failed videos and
    // must include the captured error_message (so the email body is
    // actionable).
    for (const r of result) {
      expect(failedIds).toContain(r.swingVideoId);
      expect(r.errorMessage).toMatch(/ffprobe oops/);
    }
    // The newest two seeded rows should appear (DESC by updated_at).
    expect(result[0].swingVideoId).toBe(failedIds[2]);
    expect(result[1].swingVideoId).toBe(failedIds[1]);
  });

  it("clamps a pathological sample size request to a sane maximum", async () => {
    await seedFailedRows(2);
    // Asking for 9999 must not blow up — the loader clamps to 100.
    const result = await loadRecentFpsProbeFailures(9999);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe("loadFpsProbeFailureGrowthCount", () => {
  it("counts only failed rows whose updated_at lands at or after the cutoff", async () => {
    // Seed 3 failed rows now (all with updated_at ≈ now).
    await seedFailedRows(3);
    // A cutoff in the recent past should include all three rows.
    const cutoffPast = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await loadFpsProbeFailureGrowthCount(cutoffPast);
    expect(recentCount).toBeGreaterThanOrEqual(3);

    // A cutoff in the *future* must include nothing — the rows just
    // seeded all have updated_at strictly before this cutoff.
    const cutoffFuture = new Date(Date.now() + 60 * 60 * 1000);
    const futureCount = await loadFpsProbeFailureGrowthCount(cutoffFuture);
    expect(futureCount).toBe(0);
  });

  it("ignores non-failed statuses", async () => {
    // Insert a single 'done' row that should never be counted as
    // growth even though it was just stamped.
    const [doneVideo] = await db.insert(swingVideosTable).values({
      userId: testUserId!,
      organizationId: testOrgId!,
      videoUrl: `/objects/uploads/swing-fps-growth-done-${Date.now()}`,
      view: "dtl",
    }).returning({ id: swingVideosTable.id });
    seededVideoIds.push(doneVideo.id);
    await db.insert(swingVideoFpsProbesTable).values({
      swingVideoId: doneVideo.id,
      objectPath: `/objects/uploads/swing-fps-growth-done-${doneVideo.id}`,
      status: "done",
      attempts: 1,
      nextAttemptAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const cutoffPast = new Date(Date.now() - 60 * 60 * 1000);
    const count = await loadFpsProbeFailureGrowthCount(cutoffPast);
    // No 'failed' rows at all → count is 0 even though one 'done' row
    // is fresh.
    expect(count).toBe(0);
  });
});

describe("runFpsProbeFailureOpsAlertJob — DB-driven growth (no override)", () => {
  it("computes growth from swing_video_fps_probes.updated_at when growthCountOverride is unset and pages on growth alone", async () => {
    // Seed 12 fresh failed rows (all with updated_at ≈ now). With a
    // growthDelta of 10 and a 24h lookback, the alert must fire even
    // though failedRetained (12) is below the 25-row threshold.
    await seedFailedRows(12);
    const res = await runFpsProbeFailureOpsAlertJob({
      threshold: 25,
      cooldownHours: 24,
      sampleSize: 5,
      growthDelta: 10,
      growthLookbackHours: 24,
      failedRetained: 12,
      recipients: ["ops@example.com"],
      // intentionally NOT passing growthCountOverride — query DB
      // intentionally NOT passing recentFailuresOverride — let the
      // loader query the seeded rows so the email gets actionable data
    });
    expect(res.alerted).toBe(true);
    expect(res.trigger).toEqual({ thresholdBreached: false, growthBreached: true });
    expect(res.growthCount).toBeGreaterThanOrEqual(12);
    expect(res.recentFailures.length).toBeGreaterThanOrEqual(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});
