/**
 * Integration test: Task #1127 — alert org admins when a single
 * pending_storage_deletions row first crosses the bounded-retry exhaustion
 * threshold (>= PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS attempts).
 *
 * Coverage:
 *   1. Alert (push + per-admin email) fires exactly once when the row
 *      transitions from below to at-or-above the threshold.
 *   2. Subsequent retry passes (same row, attempts continue to climb past
 *      the threshold) do NOT re-page admins — the row is dedup-stamped via
 *      `exhaustion_notified_at` and the helper is skipped.
 *
 * `comms` and `mailer` are mocked so push / email calls are observable
 * without going to a real backend, and `objectStorage` is mocked so the
 * worker treats every retry as a transient failure regardless of whether
 * a bucket is configured in the test env.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendErasureStorageFailureExhaustedEmailMock, deleteObjectByPathMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendErasureStorageFailureExhaustedEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
  deleteObjectByPathMock: vi.fn(async (_path: string): Promise<void> => {
    throw new Error("503 Service Unavailable: simulated transient failure");
  }),
}));

vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return {
    ...actual,
    sendTransactionalPush: sendTransactionalPushMock,
  };
});
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendErasureStorageFailureExhaustedEmail: sendErasureStorageFailureExhaustedEmailMock,
  };
});
vi.mock("../lib/objectStorage.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/objectStorage.js")>("../lib/objectStorage.js");
  // Make the constructor + getPrivateObjectDir always succeed so the
  // worker proceeds into deleteObjectByPath, then have that always throw.
  class FakeService {
    getPrivateObjectDir() { return "/test-bucket/private"; }
    deleteObjectByPath = deleteObjectByPathMock;
  }
  return {
    ...actual,
    ObjectStorageService: FakeService,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  pendingStorageDeletionsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  processPendingStorageDeletions,
  PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS,
} from "../lib/cron.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE pending_storage_deletions ADD COLUMN IF NOT EXISTS exhaustion_notified_at timestamptz`);
}

let testOrgId: number;
let adminUserId: number;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_StorageExhaustionAlert_${ts}`,
      slug: `test-storage-exhaustion-alert-${ts}`,
    })
    .returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [admin] = await db
    .insert(appUsersTable)
    .values({
      username: `admin-storage-exhaust-${ts}`,
      replitUserId: `admin-storage-exhaust-${ts}`,
      email: `admin-storage-exhaust-${ts}@example.com`,
      displayName: "Storage Exhaustion Admin",
      organizationId: testOrgId,
      role: "org_admin",
    })
    .returning({ id: appUsersTable.id });
  adminUserId = admin.id;
});

afterAll(async () => {
  await db.delete(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendErasureStorageFailureExhaustedEmailMock.mockClear();
  deleteObjectByPathMock.mockClear();
  await db.delete(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
});

describe("processPendingStorageDeletions — exhaustion admin alert", () => {
  it("alerts org admins exactly once when a row first crosses the exhaustion threshold", async () => {
    // Seed a row already at (threshold - 1) attempts so the very next failed
    // tick crosses the threshold. nextAttemptAt is in the past so the worker
    // will pick it up immediately.
    const [row] = await db.insert(pendingStorageDeletionsTable).values({
      organizationId: testOrgId,
      clubMemberId: null,
      path: `/objects/test-orphan-${Date.now()}.bin`,
      attempts: PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS - 1,
      nextAttemptAt: new Date(Date.now() - 60 * 1000),
    }).returning();

    const result = await processPendingStorageDeletions({ now: new Date() });
    expect(result.failed).toBe(1);

    // The row was bumped to >= threshold and the alert fired.
    const [after] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, row.id));
    expect(after.attempts).toBeGreaterThanOrEqual(PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS);
    expect(after.exhaustionNotifiedAt).not.toBeNull();

    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionalPushMock.mock.calls[0]![0]).toContain(adminUserId);

    expect(sendErasureStorageFailureExhaustedEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendErasureStorageFailureExhaustedEmailMock.mock.calls[0]![0] as {
      to: string;
      orphanPath: string;
      attempts: number;
    };
    expect(emailArgs.to).toMatch(/^admin-storage-exhaust-.+@example\.com$/);
    expect(emailArgs.orphanPath).toBe(row.path);
    expect(emailArgs.attempts).toBeGreaterThanOrEqual(PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS);
  });

  it("does not re-page admins on subsequent retry ticks of the same exhausted row", async () => {
    const [row] = await db.insert(pendingStorageDeletionsTable).values({
      organizationId: testOrgId,
      clubMemberId: null,
      path: `/objects/test-orphan-dedup-${Date.now()}.bin`,
      attempts: PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS - 1,
      nextAttemptAt: new Date(Date.now() - 60 * 1000),
    }).returning();

    // First tick — crosses the threshold, fires the alert.
    await processPendingStorageDeletions({ now: new Date() });
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    expect(sendErasureStorageFailureExhaustedEmailMock).toHaveBeenCalledTimes(1);

    // Force the row back into the due window (the worker pushed
    // nextAttemptAt out by the backoff). The exhaustion stamp must
    // survive and suppress further admin alerts even though the
    // path keeps failing.
    await db.update(pendingStorageDeletionsTable)
      .set({ nextAttemptAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(pendingStorageDeletionsTable.id, row.id));

    sendTransactionalPushMock.mockClear();
    sendErasureStorageFailureExhaustedEmailMock.mockClear();

    await processPendingStorageDeletions({ now: new Date() });
    // The row is still in the queue and still failing — but no fresh
    // admin alert because the threshold was already crossed once.
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
    expect(sendErasureStorageFailureExhaustedEmailMock).not.toHaveBeenCalled();

    const [after] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, row.id));
    expect(after.attempts).toBeGreaterThan(PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS);
    expect(after.exhaustionNotifiedAt).not.toBeNull();
  });
});
