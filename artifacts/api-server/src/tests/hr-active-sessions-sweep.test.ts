/**
 * Background sweep of stale `hr_active_sessions` rows (Task #1194).
 *
 * The active-HR-session table is normally cleaned lazily — by hrStop, and
 * by `isHrSessionActive` when it observes an expired TTL. Rows for users
 * who never POST again (rare hard crashes with no follow-up traffic) only
 * get noticed the next time someone checks that user. The hourly sweep
 * is the safety net: it drops rows whose `expires_at` is past the grace
 * window, leaving fresh and just-expired rows alone so the lazy paths
 * (and any in-flight refresh) are never disturbed.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-hr-sweep";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  appUsersTable,
  hrActiveSessionsTable,
  db,
} from "@workspace/db";
import { sweepStaleHrSessions } from "../lib/wearables.js";

const GRACE_MS = 60 * 60 * 1000; // mirrors HR_SESSION_SWEEP_GRACE_MS

let freshUserId: number;
let justExpiredUserId: number;
let longExpiredUserId: number;
const allUserIds: number[] = [];

beforeAll(async () => {
  const stamp = Date.now();
  const inserted = await db.insert(appUsersTable).values([
    { replitUserId: `hr-sweep-fresh-${stamp}`, username: `hr_sweep_fresh_${stamp}` },
    { replitUserId: `hr-sweep-just-${stamp}`, username: `hr_sweep_just_${stamp}` },
    { replitUserId: `hr-sweep-long-${stamp}`, username: `hr_sweep_long_${stamp}` },
  ]).returning({ id: appUsersTable.id });

  freshUserId = inserted[0].id;
  justExpiredUserId = inserted[1].id;
  longExpiredUserId = inserted[2].id;
  allUserIds.push(freshUserId, justExpiredUserId, longExpiredUserId);
});

afterAll(async () => {
  await db.delete(hrActiveSessionsTable).where(inArray(hrActiveSessionsTable.userId, allUserIds));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUserIds));
});

beforeEach(async () => {
  await db.delete(hrActiveSessionsTable).where(inArray(hrActiveSessionsTable.userId, allUserIds));
});

describe("sweepStaleHrSessions", () => {
  it("deletes only rows whose expires_at is past the grace window", async () => {
    const now = Date.now();

    await db.insert(hrActiveSessionsTable).values([
      // Fresh — TTL still in the future.
      { userId: freshUserId, expiresAt: new Date(now + 60 * 1000), updatedAt: new Date() },
      // Just expired — past the TTL but well within the grace window.
      // The lazy paths will collect it next time someone references this user.
      { userId: justExpiredUserId, expiresAt: new Date(now - 5 * 60 * 1000), updatedAt: new Date() },
      // Long expired — well past the grace window. This is the row the
      // sweep exists to collect (user crashed, never POSTed again).
      { userId: longExpiredUserId, expiresAt: new Date(now - 2 * GRACE_MS), updatedAt: new Date() },
    ]);

    const deleted = await sweepStaleHrSessions(new Date(now));
    // `>=` because other tests in the suite may share the table; the
    // assertions below are scoped to *our* fixtures so they're exact.
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ userId: hrActiveSessionsTable.userId })
      .from(hrActiveSessionsTable)
      .where(inArray(hrActiveSessionsTable.userId, allUserIds));

    const remainingIds = remaining.map(r => r.userId);
    expect(remainingIds).toContain(freshUserId);
    expect(remainingIds).toContain(justExpiredUserId);
    expect(remainingIds).not.toContain(longExpiredUserId);
  });

  it("is a no-op when no rows are past the grace window", async () => {
    const now = Date.now();

    await db.insert(hrActiveSessionsTable).values([
      { userId: freshUserId, expiresAt: new Date(now + 60 * 1000), updatedAt: new Date() },
      { userId: justExpiredUserId, expiresAt: new Date(now - 5 * 60 * 1000), updatedAt: new Date() },
    ]);

    // Other suites may have left long-expired rows behind; assert only
    // that *our* rows survive.
    await sweepStaleHrSessions(new Date(now));

    const remaining = await db
      .select({ userId: hrActiveSessionsTable.userId })
      .from(hrActiveSessionsTable)
      .where(inArray(hrActiveSessionsTable.userId, allUserIds));

    const remainingIds = remaining.map(r => r.userId);
    expect(remainingIds).toContain(freshUserId);
    expect(remainingIds).toContain(justExpiredUserId);
  });

  it("can be called repeatedly without error when the table is empty", async () => {
    const now = Date.now();
    // No fixtures inserted in this test — exercises the empty-table path.
    await expect(sweepStaleHrSessions(new Date(now))).resolves.toBeGreaterThanOrEqual(0);
    await expect(sweepStaleHrSessions(new Date(now))).resolves.toBeGreaterThanOrEqual(0);
  });
});
