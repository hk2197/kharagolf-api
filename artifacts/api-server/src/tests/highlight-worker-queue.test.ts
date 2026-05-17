/**
 * Test: highlight render worker queue (Task #418, covered by Task #552).
 *
 * The worker queue layer at `src/lib/highlightQueue.ts` provides three
 * crash-safety guarantees that this suite exercises end-to-end against the
 * real test database:
 *
 *   1. `claimNextRender` uses `FOR UPDATE SKIP LOCKED` so two workers that
 *      poll at the same instant never grab the same reel id.
 *   2. `recordFailure` schedules an exponential-backoff retry on every
 *      failure and flips the row to status='failed' once `MAX_ATTEMPTS`
 *      is reached, never silently dropping the job.
 *   3. `recoverStaleRendering` re-queues any row that has been stuck in
 *      'rendering' past the stale window (i.e. the worker crashed mid
 *      render). This is what keeps a SIGKILL'd ffmpeg process from
 *      stranding a player's highlight forever.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Suppress the worker's auto-start polling loops and stub out the heavy
// ffmpeg pipeline. Both must be hoisted above ESM imports so they take
// effect before `../highlightWorker.js` is evaluated.
const { executeRenderMock } = vi.hoisted(() => {
  process.env["HIGHLIGHT_WORKER_DISABLE_AUTOSTART"] = "1";
  return { executeRenderMock: vi.fn(async (_reelId: number) => {}) };
});
vi.mock("../lib/highlightRender.js", () => ({
  executeRender: executeRenderMock,
}));

import { db, highlightReelsTable, organizationsTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  MAX_ATTEMPTS,
  backoffSeconds,
  claimNextRender,
  recordFailure,
  recoverStaleRendering,
} from "../lib/highlightQueue.js";
import { processOne } from "../highlightWorker.js";

let orgId: number;
let userId: number;
const reelIds: number[] = [];

async function makeReel(overrides: Partial<typeof highlightReelsTable.$inferInsert> = {}): Promise<number> {
  const [r] = await db.insert(highlightReelsTable).values({
    organizationId: orgId,
    userId,
    title: "Test Reel",
    templateId: "classic",
    status: "queued",
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    ...overrides,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `HighlightQueueOrg_${ts}`,
    slug: `highlight-queue-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `highlight-queue-${ts}`,
    username: `highlight_queue_${ts}`,
    email: `${ts}@example.test`,
    displayName: "Highlight Queue Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
});

describe("highlight queue — concurrent claim safety", () => {
  it("two parallel claims never return the same reel id (FOR UPDATE SKIP LOCKED)", async () => {
    // Seed two ready jobs; concurrent workers must split them, not double-claim.
    const a = await makeReel();
    const b = await makeReel();

    const [r1, r2] = await Promise.all([claimNextRender(), claimNextRender()]);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1).not.toBe(r2);
    expect(new Set([r1, r2])).toEqual(new Set([a, b]));

    // A third claim with no remaining work returns null.
    const r3 = await claimNextRender();
    expect(r3).toBeNull();

    // Both rows should now be in 'rendering' with attempts incremented.
    const rows = await db.select().from(highlightReelsTable)
      .where(inArray(highlightReelsTable.id, [a, b]));
    for (const row of rows) {
      expect(row.status).toBe("rendering");
      expect(row.attempts).toBe(1);
      expect(row.renderStartedAt).not.toBeNull();
    }
  });

  it("skips rows whose next_attempt_at is in the future", async () => {
    await makeReel({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const claimed = await claimNextRender();
    expect(claimed).toBeNull();
  });
});

describe("highlight queue — retry with exponential backoff", () => {
  it("schedules a backoff retry on each failure and marks failed once the cap is reached", async () => {
    const reelId = await makeReel();

    // Simulate the worker loop: claim, fail, repeat. After MAX_ATTEMPTS-th
    // failure the row must flip to permanent 'failed' status.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Make sure the row is eligible for the next claim.
      await db.update(highlightReelsTable)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(highlightReelsTable.id, reelId));

      const claimed = await claimNextRender();
      expect(claimed).toBe(reelId);

      const before = Date.now();
      await recordFailure(reelId, `boom ${attempt}`);
      const [row] = await db.select().from(highlightReelsTable)
        .where(eq(highlightReelsTable.id, reelId));

      if (attempt < MAX_ATTEMPTS) {
        expect(row.status).toBe("queued");
        expect(row.errorMessage).toBe(`boom ${attempt}`);
        // Backoff matches the documented schedule (30s, 2m, 8m, 30m).
        const expectedDelayMs = backoffSeconds(attempt) * 1000;
        const actualDelayMs = row.nextAttemptAt.getTime() - before;
        // Generous bounds: allow ±2s for clock + DB round-trip jitter.
        expect(actualDelayMs).toBeGreaterThanOrEqual(expectedDelayMs - 2_000);
        expect(actualDelayMs).toBeLessThanOrEqual(expectedDelayMs + 2_000);
      } else {
        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(`boom ${attempt}`);
        expect(row.renderCompletedAt).not.toBeNull();
      }
      expect(row.attempts).toBe(attempt);
    }

    // Sanity: a failed row is no longer claimable, even if next_attempt_at
    // is in the past, because the status filter excludes it.
    await db.update(highlightReelsTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(highlightReelsTable.id, reelId));
    const after = await claimNextRender();
    expect(after).toBeNull();
  });

  it("truncates very long error messages to 500 chars before persisting", async () => {
    const reelId = await makeReel();
    await claimNextRender();
    const huge = "x".repeat(2000);
    await recordFailure(reelId, huge);
    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, reelId));
    expect(row.errorMessage?.length).toBe(500);
  });
});

describe("highlight worker — render error wiring", () => {
  it("catches a thrown render error and schedules a backoff retry instead of crashing", async () => {
    const reelId = await makeReel();

    // First pass: render throws → worker should call recordFailure and
    // leave the row queued with the thrown error message and a future
    // next_attempt_at, NOT propagate the exception.
    executeRenderMock.mockImplementationOnce(async () => {
      throw new Error("simulated ffmpeg crash");
    });

    const handled = await processOne();
    expect(handled).toBe(true);
    expect(executeRenderMock).toHaveBeenCalledWith(reelId);

    const [afterFailure] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, reelId));
    expect(afterFailure.status).toBe("queued");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.errorMessage).toBe("simulated ffmpeg crash");
    expect(afterFailure.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Second pass: render succeeds → worker leaves the row in 'rendering'
    // (it's executeRender's job to flip status='ready'). The important
    // contract is that no error is thrown and recordFailure is NOT called.
    await db.update(highlightReelsTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(highlightReelsTable.id, reelId));
    executeRenderMock.mockResolvedValueOnce(undefined);

    const handled2 = await processOne();
    expect(handled2).toBe(true);

    const [afterSuccess] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, reelId));
    expect(afterSuccess.status).toBe("rendering");
    expect(afterSuccess.attempts).toBe(2);

    // With nothing queued, processOne reports "no work" and returns false.
    const handled3 = await processOne();
    expect(handled3).toBe(false);
  });
});

describe("highlight queue — stale render recovery", () => {
  it("re-queues rows stuck in 'rendering' past the stale window", async () => {
    // Simulate a worker that claimed a reel and then crashed: status is
    // 'rendering' and renderStartedAt is well outside the stale window.
    const stuckLongAgo = await makeReel({
      status: "rendering",
      attempts: 1,
      renderStartedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    });
    // A second, fresh in-flight render that should NOT be touched.
    const freshlyRendering = await makeReel({
      status: "rendering",
      attempts: 1,
      renderStartedAt: new Date(Date.now() - 30 * 1000), // 30s ago
    });

    const recovered = await recoverStaleRendering(15 * 60);
    expect(recovered).toBe(1);

    const [stuck] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, stuckLongAgo));
    expect(stuck.status).toBe("queued");
    expect(stuck.errorMessage).toMatch(/Worker crashed/i);
    expect(stuck.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const [fresh] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, freshlyRendering));
    expect(fresh.status).toBe("rendering");
    expect(fresh.errorMessage).toBeNull();

    // After recovery the requeued reel can be picked up again by a worker.
    const claimed = await claimNextRender();
    expect(claimed).toBe(stuckLongAgo);
  });
});
