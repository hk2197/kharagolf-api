/**
 * Task #1584 — Bounded background auto-retry for legacy NULL-duration
 * videos.
 *
 * Coverage:
 *   1. A successful re-probe writes durationSeconds, clears the
 *      auto-retry count, the unverifiable reason, and the
 *      lastCheckedAt stamp.
 *   2. A failed re-probe under the cap increments the count, stamps
 *      lastCheckedAt, and leaves duration_unverifiable_reason NULL so
 *      the row is still in-flight (does NOT show on the admin list).
 *   3. A failed re-probe that crosses the cap flags the row with
 *      `permanently_unverifiable`, leaving the count at the cap.
 *   4. An ObjectNotFoundError that crosses the cap flags the row with
 *      `object_missing` instead.
 *   5. Per-row backoff: a row whose last_checked_at is too recent is
 *      skipped this pass.
 *   6. Already-flagged rows (durationUnverifiableReason IS NOT NULL)
 *      are skipped — the cron never re-probes them.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-legacy-video-recheck-cron";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Stub the shared probe lib so we control success / failure / missing
// without needing real ffprobe + object storage in the test container.
// The cron loads this module dynamically (lazy import) so vi.mock
// replaces it before the cron's first call.
const probeMock = vi.hoisted(() => vi.fn<(p: string) => Promise<number | null>>());
vi.mock("../lib/mediaDurationProbe", () => ({
  probeMediaDurationSeconds: probeMock,
}));

import { db, organizationsTable, mediaTable } from "@workspace/db";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  recheckLegacyVideoDurations,
  _setLegacyVideoRecheckTuningForTest,
} from "../lib/cron.js";
import { ObjectNotFoundError } from "../lib/objectStorage.js";

let orgId: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `legacy-vid-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `LegacyVid_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
});

afterAll(async () => {
  if (mediaIds.length) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Tighten the cap so a single failure crosses it — keeps the test
  // fast and exercises the give-up path with one mocked probe call.
  // Per-row backoff stays at 1ms so freshly-stamped rows can still be
  // re-probed by a follow-up pass within the same test if needed.
  _setLegacyVideoRecheckTuningForTest({ autoRetryCap: 1, perRowMs: 1, batchSize: 50 });
  probeMock.mockReset();

  // The cron sweeps every NULL-duration video in the DB — including
  // rows other suites left behind. Flag them all as already
  // unverifiable for the duration of this test so our mock only ever
  // fires for the rows we explicitly seed in this org.
  await db
    .update(mediaTable)
    .set({ durationUnverifiableReason: "permanently_unverifiable" })
    .where(and(
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      isNull(mediaTable.durationUnverifiableReason),
      ne(mediaTable.organizationId, orgId),
    ));
});

afterEach(async () => {
  _setLegacyVideoRecheckTuningForTest(null);
  if (mediaIds.length) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
});

async function seedRow(values: Partial<typeof mediaTable.$inferInsert> = {}) {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.mp4`,
    mediaType: "video",
    durationSeconds: null,
    approved: true,
    uploaderName: "Tester",
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

async function readRow(id: number) {
  const [r] = await db
    .select({
      duration: mediaTable.durationSeconds,
      lastCheckedAt: mediaTable.durationLastCheckedAt,
      autoRecheckCount: mediaTable.durationAutoRecheckCount,
      reason: mediaTable.durationUnverifiableReason,
    })
    .from(mediaTable)
    .where(eq(mediaTable.id, id))
    .limit(1);
  return r;
}

describe("recheckLegacyVideoDurations", () => {
  it("recovers a row when the probe finally returns a duration", async () => {
    // Cap is set to 1 to keep the give-up tests fast, but a recovery
    // shouldn't depend on the cap value at all.
    _setLegacyVideoRecheckTuningForTest({ autoRetryCap: 5, perRowMs: 1, batchSize: 50 });
    const id = await seedRow();
    probeMock.mockResolvedValueOnce(42);

    const result = await recheckLegacyVideoDurations();
    expect(result.recovered).toBe(1);
    expect(result.stillFailing).toBe(0);
    expect(result.flaggedMissing).toBe(0);
    expect(result.flaggedUnverifiable).toBe(0);

    const row = await readRow(id);
    expect(row.duration).toBe(42);
    expect(row.autoRecheckCount).toBe(0);
    expect(row.reason).toBeNull();
    expect(row.lastCheckedAt).toBeNull();
  });

  it("increments the count on failure under the cap without flagging", async () => {
    _setLegacyVideoRecheckTuningForTest({ autoRetryCap: 5, perRowMs: 1, batchSize: 50 });
    const id = await seedRow();
    probeMock.mockResolvedValueOnce(null);

    const result = await recheckLegacyVideoDurations();
    expect(result.recovered).toBe(0);
    expect(result.stillFailing).toBe(1);
    expect(result.flaggedUnverifiable).toBe(0);
    expect(result.flaggedMissing).toBe(0);

    const row = await readRow(id);
    expect(row.duration).toBeNull();
    expect(row.autoRecheckCount).toBe(1);
    expect(row.reason).toBeNull();
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("flags 'permanently_unverifiable' once the cap is reached on probe failure", async () => {
    // Cap=1 means a single failed probe crosses the threshold.
    const id = await seedRow();
    probeMock.mockResolvedValueOnce(null);

    const result = await recheckLegacyVideoDurations();
    expect(result.stillFailing).toBe(1);
    expect(result.flaggedUnverifiable).toBe(1);
    expect(result.flaggedMissing).toBe(0);

    const row = await readRow(id);
    expect(row.autoRecheckCount).toBe(1);
    expect(row.reason).toBe("permanently_unverifiable");
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("flags 'object_missing' when the probe throws ObjectNotFoundError at the cap", async () => {
    const id = await seedRow();
    probeMock.mockRejectedValueOnce(new ObjectNotFoundError());

    const result = await recheckLegacyVideoDurations();
    expect(result.flaggedMissing).toBe(1);
    expect(result.flaggedUnverifiable).toBe(0);

    const row = await readRow(id);
    expect(row.reason).toBe("object_missing");
    expect(row.autoRecheckCount).toBe(1);
  });

  it("respects per-row backoff and skips rows checked too recently", async () => {
    // Set a long backoff so the freshly-stamped row is NOT eligible.
    _setLegacyVideoRecheckTuningForTest({
      autoRetryCap: 5,
      perRowMs: 60 * 60 * 1000, // 1h
      batchSize: 50,
    });
    const id = await seedRow({
      // Just stamped — well within the 1h backoff.
      durationLastCheckedAt: new Date(),
      durationAutoRecheckCount: 2,
    });

    const result = await recheckLegacyVideoDurations();
    expect(result.rowsConsidered).toBe(0);
    expect(probeMock).not.toHaveBeenCalled();

    // Counter unchanged.
    const row = await readRow(id);
    expect(row.autoRecheckCount).toBe(2);
    expect(row.reason).toBeNull();
  });

  it("never re-probes rows the cron has already given up on", async () => {
    const id = await seedRow({
      durationUnverifiableReason: "permanently_unverifiable",
      durationAutoRecheckCount: 5,
      durationLastCheckedAt: new Date(0), // ancient — backoff would otherwise allow
    });

    const result = await recheckLegacyVideoDurations();
    expect(result.rowsConsidered).toBe(0);
    expect(probeMock).not.toHaveBeenCalled();

    // Bookkeeping unchanged.
    const row = await readRow(id);
    expect(row.reason).toBe("permanently_unverifiable");
    expect(row.autoRecheckCount).toBe(5);
  });
});
