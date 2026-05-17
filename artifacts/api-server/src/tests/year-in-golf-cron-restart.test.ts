/**
 * Test #1277 — A restarted Year-in-Golf launch cron must never re-fire
 * a push broadcast that already went out.
 *
 * Task #450 moved the launch broadcaster's send-state from an in-process
 * `Set` to a `recap_broadcasts` row claimed via INSERT ... ON CONFLICT
 * DO NOTHING before any push batch is dispatched. This regression test
 * exercises that contract end-to-end:
 *
 *   1. Seeds eligible users (device token + preferPush=true).
 *   2. Stubs `sendPushToUsers` so we can count broadcast calls.
 *   3. Runs `tick(now)` once and asserts exactly one broadcast fired.
 *   4. Simulates a server restart by clearing the in-memory
 *      `primedWindows` Set (the only in-process state — the dedup
 *      contract itself lives in the DB).
 *   5. Runs `tick(now)` again on the same simulated date and asserts
 *      `sendPushToUsers` was NOT called a second time.
 *
 * Bonus: each launch-day in the cadence (day 1 launch + day 4 + day 7
 * reminders) is exercised independently — a restart inside a launch
 * window must suppress only the already-fired sends, not the
 * still-upcoming reminders. We use Apr 1 / Apr 4 / Apr 7 (Q1 launch
 * window) because those dates have only ONE pending launch, keeping
 * the call-count assertions unambiguous.
 *
 * `computeYearInGolf` is mocked because the cache-warming aggregation
 * is irrelevant to the dedup behaviour under test and is expensive to
 * run for synthetic users.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock, computeYearInGolfMock, primeYearInGolfCacheMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(async () => ({
    attempted: 0,
    sent: 0,
    failed: 0,
    invalid: 0,
  })),
  computeYearInGolfMock: vi.fn(async () => ({})),
  // Task #1842 — the cron now warms entries through `primeYearInGolfCache`
  // (which writes into the same in-memory recap cache as the request
  // handlers) rather than calling `computeYearInGolf` directly. We stub
  // it to a no-op here because the dedup contract under test is
  // independent of the warm-up payload.
  primeYearInGolfCacheMock: vi.fn(async () => ({})),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

vi.mock("../lib/year-in-golf.js", () => ({
  computeYearInGolf: computeYearInGolfMock,
  primeYearInGolfCache: primeYearInGolfCacheMock,
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  deviceTokensTable,
  userNotificationPrefsTable,
  recapBroadcastsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  tick,
  pendingLaunches,
  _resetPrimedWindowsForTest,
} from "../lib/year-in-golf-cron.js";

// Use a far-future year so the test's recap_broadcasts rows never collide
// with anything a developer might seed for the real product.
const TEST_YEAR = 3026;

let testOrgId: number;
const userIds: number[] = [];

async function makeEligibleUser(suffix: string): Promise<number> {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `yig-cron-${suffix}-${ts}`,
    username: `yig_cron_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `Recap Player ${suffix}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  // Eligibility = at least one device token + preferPush != false.
  await db.insert(deviceTokensTable).values({
    userId: u.id,
    token: `ExponentPushToken[${suffix}-${ts}]`,
    platform: "expo",
  });
  await db.insert(userNotificationPrefsTable).values({
    userId: u.id,
    preferPush: true,
  });
  userIds.push(u.id);
  return u.id;
}

async function clearTestRecapBroadcasts() {
  await db.delete(recapBroadcastsTable).where(eq(recapBroadcastsTable.year, TEST_YEAR));
  // Task #1496 — the cron now writes per-recipient audit log rows for
  // each broadcast. Tear them down between cases so a previous test's
  // rows can't leak into the next one's user-id assertions.
  if (userIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, userIds));
  }
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `YIGCronOrg_${ts}`,
    slug: `yig-cron-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  await clearTestRecapBroadcasts();
  if (userIds.length > 0) {
    await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.userId, userIds));
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
    userIds.length = 0;
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  sendPushToUsersMock.mockClear();
  computeYearInGolfMock.mockClear();
  primeYearInGolfCacheMock.mockClear();
  _resetPrimedWindowsForTest();
  await clearTestRecapBroadcasts();
});

/**
 * Sanity: the test dates we picked are inside a launch window AND carry
 * exactly one pending launch (so call-count assertions are unambiguous).
 */
describe("year-in-golf-cron — date-window sanity", () => {
  it("Apr 1 / Apr 4 / Apr 7 each have exactly one pending launch (Q1 of the test year)", () => {
    for (const day of [1, 4, 7]) {
      const now = new Date(Date.UTC(TEST_YEAR, 3, day, 12, 0, 0));
      const launches = pendingLaunches(now);
      expect(launches).toHaveLength(1);
      expect(launches[0].period).toBe("q1");
      expect(launches[0].year).toBe(TEST_YEAR);
      expect(launches[0].day).toBe(day);
    }
  });
});

describe("year-in-golf-cron — restart dedup contract (Task #450)", () => {
  it("does not re-send the launch push after an in-process state drop on the same simulated date", async () => {
    await makeEligibleUser("restart_a");
    await makeEligibleUser("restart_b");

    const now = new Date(Date.UTC(TEST_YEAR, 3, 1, 12, 0, 0)); // Q1 launch day

    // First tick: fans out the launch broadcast to the eligible users.
    await tick(now);
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const firstCall = sendPushToUsersMock.mock.calls[0] as unknown as [number[], string, string, Record<string, string>];
    expect(firstCall[0]).toEqual(expect.arrayContaining(userIds));

    // Task #1842 — the cron's prime path must delegate to
    // `primeYearInGolfCache` (which writes into the same in-memory
    // recap cache as the request handlers) rather than the raw
    // `computeYearInGolf`. We expect one prime call per eligible
    // recipient, and zero direct `computeYearInGolf` calls from the
    // cron itself.
    expect(primeYearInGolfCacheMock).toHaveBeenCalledTimes(userIds.length);
    expect(computeYearInGolfMock).not.toHaveBeenCalled();
    for (const uid of userIds) {
      expect(primeYearInGolfCacheMock).toHaveBeenCalledWith(uid, TEST_YEAR, "q1");
    }

    // The DB-backed dedup row must exist so a restarted process can see it.
    const claimedRows = await db
      .select({ year: recapBroadcastsTable.year, period: recapBroadcastsTable.period, day: recapBroadcastsTable.day })
      .from(recapBroadcastsTable)
      .where(and(
        eq(recapBroadcastsTable.year, TEST_YEAR),
        eq(recapBroadcastsTable.period, "q1"),
        eq(recapBroadcastsTable.day, 1),
      ));
    expect(claimedRows).toHaveLength(1);

    // Task #1496 — the cron must also have written one per-recipient
    // audit row per eligible user, with the year/period/day stamped
    // into the payload so the admin drill-down can match them back.
    const auditRows = await db
      .select()
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.notificationKey, "recap.year.ready"),
        inArray(notificationAuditLogTable.userId, userIds),
      ));
    expect(auditRows).toHaveLength(userIds.length);
    for (const row of auditRows) {
      expect(row.channel).toBe("push");
      expect(row.status).toBe("sent");
      const payload = row.payload as { year?: number; period?: string; day?: number; kind?: string };
      expect(payload.year).toBe(TEST_YEAR);
      expect(payload.period).toBe("q1");
      expect(payload.day).toBe(1);
      expect(payload.kind).toBe("launch");
    }

    // Simulate a server restart: every in-process dedup state goes away.
    // The DB row is the ONLY thing that should keep the second tick from
    // re-firing the push.
    _resetPrimedWindowsForTest();

    await tick(now);

    // Still exactly one push call — the restart did not re-broadcast.
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);

    // …and exactly one audit row per recipient — the dedup also keeps
    // us from re-stamping the audit log on the second tick.
    const auditRowsAfter = await db
      .select()
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.notificationKey, "recap.year.ready"),
        inArray(notificationAuditLogTable.userId, userIds),
      ));
    expect(auditRowsAfter).toHaveLength(userIds.length);
  });

  it.each([1, 4, 7])(
    "day %i of the launch window fires its OWN push exactly once and survives a restart",
    async (day) => {
      await makeEligibleUser(`day${day}_user`);

      const now = new Date(Date.UTC(TEST_YEAR, 3, day, 12, 0, 0));

      await tick(now);
      expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);

      // Claimed slot recorded on the (year, period, day) tuple for this
      // specific reminder day — not just the launch day.
      const rows = await db
        .select()
        .from(recapBroadcastsTable)
        .where(and(
          eq(recapBroadcastsTable.year, TEST_YEAR),
          eq(recapBroadcastsTable.period, "q1"),
          eq(recapBroadcastsTable.day, day),
        ));
      expect(rows).toHaveLength(1);

      // Restart simulation — the DB claim must keep the second tick quiet.
      _resetPrimedWindowsForTest();
      await tick(now);
      expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    },
  );

  it("non-reminder days (e.g. day 2) inside a launch window do NOT fire a push", async () => {
    await makeEligibleUser("day2_user");

    const now = new Date(Date.UTC(TEST_YEAR, 3, 2, 12, 0, 0)); // mid-window, not a reminder day
    await tick(now);
    expect(sendPushToUsersMock).not.toHaveBeenCalled();

    // No claim row should be written for a non-reminder day either.
    const rows = await db
      .select()
      .from(recapBroadcastsTable)
      .where(and(
        eq(recapBroadcastsTable.year, TEST_YEAR),
        eq(recapBroadcastsTable.period, "q1"),
        eq(recapBroadcastsTable.day, 2),
      ));
    expect(rows).toHaveLength(0);
  });
});
