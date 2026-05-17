/**
 * Test: Highlight reel progress fields (Task #551, covered by Task #658).
 *
 * Task #551 added live render-progress fields to the highlight reel API
 * responses so waiting players can see exactly what their reel is doing:
 *
 *   - queuePosition          1-based position in the ready-to-run queue
 *   - estimatedWaitSeconds   queuePosition * AVG_RENDER_SECONDS (capped)
 *   - isRetrying             true when queued + attempts>0 + backoff in future
 *   - retryInSeconds         seconds until the next retry attempt
 *   - maxAttempts            constant cap from the queue module
 *
 * This suite locks down the contract end-to-end against the real test
 * database for both list and detail endpoints, in every reel state
 * (queued, queued-with-backoff, rendering, ready, failed). It also
 * directly exercises getQueuePosition() and getQueueDepth() in
 * `src/lib/highlightQueue.ts`, the SQL backing the API fields.
 *
 * The render queue's enqueue path is stubbed out so creating reels via
 * the route doesn't kick off ffmpeg in the test process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return {
    ...actual,
    enqueueRender: vi.fn(async (_id: number) => {}),
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  highlightReelsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  MAX_ATTEMPTS,
  AVG_RENDER_SECONDS,
  getQueuePosition,
  getQueueDepth,
} from "../lib/highlightQueue.js";
import { createTestApp, type TestUser } from "./helpers";

let orgId: number;
let otherOrgId: number;
let userId: number;
let otherUserId: number;
const reelIds: number[] = [];

async function makeReel(overrides: Partial<typeof highlightReelsTable.$inferInsert> = {}): Promise<number> {
  const [r] = await db.insert(highlightReelsTable).values({
    organizationId: orgId,
    userId,
    title: "Progress Test",
    templateId: "classic",
    status: "queued",
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    ...overrides,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(r.id);
  return r.id;
}

function asUser(id: number, organizationId: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId };
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [o] = await db.insert(organizationsTable).values({
    name: `HighlightProgressOrg_${ts}`,
    slug: `hl-progress-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [o2] = await db.insert(organizationsTable).values({
    name: `HighlightProgressOther_${ts}`,
    slug: `hl-progress-other-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = o2.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `hl-progress-${ts}`,
    username: `hl_progress_${ts}`,
    email: `${ts}@progress.test`,
    displayName: "Progress Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `hl-progress-other-${ts}`,
    username: `hl_progress_other_${ts}`,
    email: `${ts}-other@progress.test`,
    displayName: "Other Org Tester",
    role: "player",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = u2.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId, role: "player" },
    { organizationId: otherOrgId, userId: otherUserId, role: "player" },
  ]);
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  for (const u of [userId, otherUserId].filter(Boolean)) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, u));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(async () => {
  // Wipe any reels left behind by other suites that might pollute the
  // global queue counts measured here. Scope the wipe to our test users
  // (and the reels we created) so we never touch unrelated data.
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
  await db.delete(highlightReelsTable).where(eq(highlightReelsTable.userId, userId));
  await db.delete(highlightReelsTable).where(eq(highlightReelsTable.userId, otherUserId));
});

// ─────────────────────────────────────────────────────────────────────────────
// Library-level: getQueuePosition + getQueueDepth
// ─────────────────────────────────────────────────────────────────────────────

describe("highlightQueue.getQueuePosition() / getQueueDepth()", () => {
  it("returns 1-based position ordered by next_attempt_at, then id", async () => {
    // Three queued+ready reels, deliberately created out of timestamp order
    // so the test pins behaviour to the SQL ORDER BY, not insert order.
    const middle = await makeReel({ nextAttemptAt: new Date(Date.now() - 5_000) });
    const oldest = await makeReel({ nextAttemptAt: new Date(Date.now() - 10_000) });
    const newest = await makeReel({ nextAttemptAt: new Date(Date.now() - 1_000) });

    expect(await getQueuePosition(oldest)).toBe(1);
    expect(await getQueuePosition(middle)).toBe(2);
    expect(await getQueuePosition(newest)).toBe(3);
  });

  it("breaks ties on next_attempt_at by ascending id", async () => {
    const sameTs = new Date(Date.now() - 2_000);
    const first = await makeReel({ nextAttemptAt: sameTs });
    const second = await makeReel({ nextAttemptAt: sameTs });

    expect(await getQueuePosition(first)).toBe(1);
    expect(await getQueuePosition(second)).toBe(2);
  });

  it("returns null for reels that are not queued (rendering/ready/failed)", async () => {
    const rendering = await makeReel({ status: "rendering", attempts: 1, renderStartedAt: new Date() });
    const ready = await makeReel({
      status: "ready",
      renderCompletedAt: new Date(),
      outputObjectPath: "/objects/test/out.mp4",
    });
    const failed = await makeReel({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorMessage: "boom",
      renderCompletedAt: new Date(),
    });

    expect(await getQueuePosition(rendering)).toBeNull();
    expect(await getQueuePosition(ready)).toBeNull();
    expect(await getQueuePosition(failed)).toBeNull();
  });

  it("returns null when next_attempt_at is in the future (waiting on backoff)", async () => {
    const future = await makeReel({
      status: "queued",
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    expect(await getQueuePosition(future)).toBeNull();
  });

  it("getQueueDepth() counts only ready-to-run queued reels", async () => {
    const baseline = await getQueueDepth();
    await makeReel(); // ready, queued
    await makeReel(); // ready, queued
    await makeReel({ nextAttemptAt: new Date(Date.now() + 60_000), attempts: 1 }); // backoff, not ready
    await makeReel({ status: "rendering", attempts: 1, renderStartedAt: new Date() });
    await makeReel({ status: "ready", outputObjectPath: "/objects/x.mp4" });
    await makeReel({ status: "failed", attempts: MAX_ATTEMPTS, errorMessage: "x" });

    expect(await getQueueDepth()).toBe(baseline + 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /portal/highlights (list) — progress fields per state
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portal/highlights — progress fields per reel state", () => {
  it("attaches queuePosition + estimatedWaitSeconds for queued reels and null for terminal states", async () => {
    // Build one of each non-trivial state for the same user. Note: the
    // route returns reels for this user only, so cross-user pollution
    // can't affect what the body contains (only the queue position
    // numbers, which include the global ready queue).
    const queued = await makeReel({ nextAttemptAt: new Date(Date.now() - 1_000) });
    const backoff = await makeReel({
      status: "queued",
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 30_000),
      errorMessage: "transient",
    });
    const rendering = await makeReel({
      status: "rendering",
      attempts: 1,
      renderStartedAt: new Date(),
    });
    const ready = await makeReel({
      status: "ready",
      outputObjectPath: "/objects/test/ready.mp4",
      thumbnailPath: "/objects/test/ready.jpg",
      renderCompletedAt: new Date(),
    });
    const failed = await makeReel({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorMessage: "ffmpeg blew up",
      renderCompletedAt: new Date(),
    });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).get("/api/portal/highlights");
    expect(res.status).toBe(200);

    const reels = res.body.reels as Array<{
      id: number;
      status: string;
      queuePosition: number | null;
      estimatedWaitSeconds: number | null;
      isRetrying: boolean;
      retryInSeconds: number | null;
      maxAttempts: number;
    }>;
    const byId = new Map(reels.map(r => [r.id, r]));

    // maxAttempts is reported on every row.
    for (const r of reels) expect(r.maxAttempts).toBe(MAX_ATTEMPTS);

    // Queued + ready: position is 1 (it's the only ready-to-run row for
    // this user), estimated wait is position * AVG_RENDER_SECONDS.
    const q = byId.get(queued)!;
    expect(q.status).toBe("queued");
    expect(q.queuePosition).toBe(1);
    expect(q.estimatedWaitSeconds).toBe(1 * AVG_RENDER_SECONDS);
    expect(q.isRetrying).toBe(false);
    expect(q.retryInSeconds).toBeNull();

    // Queued waiting on backoff: queue position is null (not ready yet)
    // but isRetrying must be true and retryInSeconds must be a positive
    // count of seconds-until-next-attempt.
    const b = byId.get(backoff)!;
    expect(b.status).toBe("queued");
    expect(b.queuePosition).toBeNull();
    expect(b.estimatedWaitSeconds).toBeNull();
    expect(b.isRetrying).toBe(true);
    expect(b.retryInSeconds).not.toBeNull();
    expect(b.retryInSeconds!).toBeGreaterThan(0);
    expect(b.retryInSeconds!).toBeLessThanOrEqual(31);

    // Rendering: no queue position, not retrying.
    const r = byId.get(rendering)!;
    expect(r.status).toBe("rendering");
    expect(r.queuePosition).toBeNull();
    expect(r.estimatedWaitSeconds).toBeNull();
    expect(r.isRetrying).toBe(false);
    expect(r.retryInSeconds).toBeNull();

    // Ready & failed: terminal states, all live progress fields null/false.
    const rd = byId.get(ready)!;
    expect(rd.queuePosition).toBeNull();
    expect(rd.estimatedWaitSeconds).toBeNull();
    expect(rd.isRetrying).toBe(false);
    expect(rd.retryInSeconds).toBeNull();

    const f = byId.get(failed)!;
    expect(f.status).toBe("failed");
    expect(f.queuePosition).toBeNull();
    expect(f.estimatedWaitSeconds).toBeNull();
    expect(f.isRetrying).toBe(false);
    expect(f.retryInSeconds).toBeNull();
  });

  it("queuePosition reflects the global ready queue, not just this user's reels", async () => {
    // Other-org user has two reels ahead of ours in the ready queue —
    // our reel should report position 3, not 1, because the queue is
    // shared across the worker.
    await db.insert(highlightReelsTable).values([
      {
        organizationId: otherOrgId, userId: otherUserId,
        title: "ahead 1", templateId: "classic", status: "queued",
        attempts: 0, nextAttemptAt: new Date(Date.now() - 10_000),
      },
      {
        organizationId: otherOrgId, userId: otherUserId,
        title: "ahead 2", templateId: "classic", status: "queued",
        attempts: 0, nextAttemptAt: new Date(Date.now() - 5_000),
      },
    ]);
    const mine = await makeReel({ nextAttemptAt: new Date(Date.now() - 1_000) });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).get("/api/portal/highlights");
    expect(res.status).toBe(200);
    const row = (res.body.reels as Array<{ id: number; queuePosition: number | null; estimatedWaitSeconds: number | null }>)
      .find(r => r.id === mine)!;
    expect(row.queuePosition).toBe(3);
    expect(row.estimatedWaitSeconds).toBe(3 * AVG_RENDER_SECONDS);
  });

  it("includes a queueDepth on the list payload that matches getQueueDepth()", async () => {
    await makeReel(); // 1 ready
    await makeReel(); // 2 ready
    await makeReel({ nextAttemptAt: new Date(Date.now() + 60_000), attempts: 1 }); // backoff
    const expected = await getQueueDepth();

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).get("/api/portal/highlights");
    expect(res.status).toBe(200);
    expect(res.body.queueDepth).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /portal/highlights/:id (detail) — progress fields per state
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portal/highlights/:id — progress fields per reel state", () => {
  async function fetchDetail(reelId: number) {
    const app = createTestApp(asUser(userId, orgId));
    return request(app).get(`/api/portal/highlights/${reelId}`);
  }

  it("queued + ready: returns queuePosition=1 and estimatedWaitSeconds for a single waiting reel", async () => {
    const reelId = await makeReel();
    const res = await fetchDetail(reelId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.queuePosition).toBe(1);
    expect(res.body.estimatedWaitSeconds).toBe(1 * AVG_RENDER_SECONDS);
    expect(res.body.isRetrying).toBe(false);
    expect(res.body.retryInSeconds).toBeNull();
    expect(res.body.maxAttempts).toBe(MAX_ATTEMPTS);
  });

  it("queued + backoff: returns null queue position, isRetrying=true, retryInSeconds in range", async () => {
    const reelId = await makeReel({
      status: "queued",
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 45_000),
      errorMessage: "transient",
    });
    const res = await fetchDetail(reelId);
    expect(res.status).toBe(200);
    expect(res.body.queuePosition).toBeNull();
    expect(res.body.estimatedWaitSeconds).toBeNull();
    expect(res.body.isRetrying).toBe(true);
    expect(res.body.retryInSeconds).toBeGreaterThan(0);
    expect(res.body.retryInSeconds).toBeLessThanOrEqual(46);
  });

  it("rendering: queue position null, isRetrying false even when attempts>0", async () => {
    const reelId = await makeReel({
      status: "rendering",
      attempts: 1,
      renderStartedAt: new Date(),
    });
    const res = await fetchDetail(reelId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rendering");
    expect(res.body.queuePosition).toBeNull();
    expect(res.body.estimatedWaitSeconds).toBeNull();
    expect(res.body.isRetrying).toBe(false);
    expect(res.body.retryInSeconds).toBeNull();
  });

  it("ready: every progress field is null/false", async () => {
    const reelId = await makeReel({
      status: "ready",
      outputObjectPath: "/objects/test/done.mp4",
      thumbnailPath: "/objects/test/done.jpg",
      renderCompletedAt: new Date(),
    });
    const res = await fetchDetail(reelId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.queuePosition).toBeNull();
    expect(res.body.estimatedWaitSeconds).toBeNull();
    expect(res.body.isRetrying).toBe(false);
    expect(res.body.retryInSeconds).toBeNull();
    expect(res.body.maxAttempts).toBe(MAX_ATTEMPTS);
  });

  it("failed: every progress field is null/false even with prior attempts", async () => {
    const reelId = await makeReel({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorMessage: "ffmpeg blew up",
      renderCompletedAt: new Date(),
    });
    const res = await fetchDetail(reelId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.queuePosition).toBeNull();
    expect(res.body.estimatedWaitSeconds).toBeNull();
    expect(res.body.isRetrying).toBe(false);
    expect(res.body.retryInSeconds).toBeNull();
  });

  it("estimatedWaitSeconds is capped at 1 hour for very deep queues", async () => {
    // Stuff the global ready queue with enough reels that position * AVG
    // would otherwise exceed 3600 seconds. The cap protects waiting
    // players from seeing alarming "you'll wait 3 hours" numbers.
    const padCount = Math.ceil(3600 / AVG_RENDER_SECONDS) + 5;
    const padRows: typeof highlightReelsTable.$inferInsert[] = [];
    for (let i = 0; i < padCount; i++) {
      padRows.push({
        organizationId: otherOrgId, userId: otherUserId,
        title: `pad ${i}`, templateId: "classic", status: "queued",
        attempts: 0,
        // Stagger so ordering is deterministic and they're all ahead.
        nextAttemptAt: new Date(Date.now() - 60_000 - i * 1000),
      });
    }
    await db.insert(highlightReelsTable).values(padRows);
    const mine = await makeReel({ nextAttemptAt: new Date(Date.now() - 1_000) });

    const res = await fetchDetail(mine);
    expect(res.status).toBe(200);
    expect(res.body.queuePosition).toBeGreaterThan(3600 / AVG_RENDER_SECONDS);
    expect(res.body.estimatedWaitSeconds).toBe(60 * 60);
  });

  it("returns 404 for a reel owned by another user (no progress leak)", async () => {
    const [foreign] = await db.insert(highlightReelsTable).values({
      organizationId: otherOrgId, userId: otherUserId,
      title: "not yours", templateId: "classic", status: "queued",
      attempts: 0, nextAttemptAt: new Date(Date.now() - 1000),
    }).returning({ id: highlightReelsTable.id });

    const app = createTestApp(asUser(userId, orgId));
    const res = await request(app).get(`/api/portal/highlights/${foreign.id}`);
    expect(res.status).toBe(404);
  });
});
