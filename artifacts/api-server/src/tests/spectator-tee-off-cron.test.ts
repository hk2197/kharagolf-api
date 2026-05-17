/**
 * Test: spectator tee-off countdown cron (sendSpectatorTeeOffAlerts).
 *
 * Verifies:
 *   1. Only groups whose teeTime falls in [now+4m, now+10m] trigger pushes.
 *   2. Followers with notifyTeeOff = false are excluded.
 *   3. A second invocation does not re-push the same tee time (dedup).
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * The api-server vitest suite runs in a single fork against a shared
 * dev DB and `sendSpectatorTeeOffAlerts` sweeps `tee_times` globally,
 * so unscoped `mock).toHaveBeenCalledTimes(N)` totals would flake the
 * moment a sibling cron test seeds another in-window tee time. This
 * file filters `sendPushToUsersMock` calls by the spectator userIds
 * inserted by the current test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 0,
      sent: 0,
      failed: 0,
      invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  playersTable,
  teeTimesTable,
  teeTimePlayersTable,
  spectatorFollowsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  sendSpectatorTeeOffAlerts,
  _resetSpectatorTeeOffDedupForTest,
} from "../lib/cron.js";

let testOrgId: number;
let tournamentId: number;
const userIds: number[] = [];
const playerIds: number[] = [];
const teeTimeIds: number[] = [];

async function makeUser(suffix: string) {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `tee-off-cron-${suffix}-${ts}`,
    username: `tee_off_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `Spectator ${suffix}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makePlayer(firstName: string) {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    firstName,
    lastName: "Test",
  }).returning({ id: playersTable.id });
  playerIds.push(p.id);
  return p.id;
}

async function makeTeeTime(teeTime: Date, players: number[]) {
  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId,
    round: 1,
    teeTime,
    startingHole: 1,
  }).returning({ id: teeTimesTable.id });
  teeTimeIds.push(tt.id);
  for (const playerId of players) {
    await db.insert(teeTimePlayersTable).values({ teeTimeId: tt.id, playerId });
  }
  return tt.id;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TeeOffCronOrg_${ts}`,
    slug: `tee-off-cron-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [tourn] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    name: `TeeOffCron_${ts}`,
    status: "active",
    startDate: new Date(),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tourn.id;
});

afterAll(async () => {
  if (teeTimeIds.length > 0) {
    await db.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, teeTimeIds));
    await db.delete(teeTimesTable).where(inArray(teeTimesTable.id, teeTimeIds));
  }
  if (userIds.length > 0) {
    await db.delete(spectatorFollowsTable).where(inArray(spectatorFollowsTable.userId, userIds));
  }
  if (playerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, playerIds));
  }
  if (tournamentId) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  }
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  // Fresh state: clear seeded tee times/players/follows and dedup memory.
  if (teeTimeIds.length > 0) {
    await db.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, teeTimeIds));
    await db.delete(teeTimesTable).where(inArray(teeTimesTable.id, teeTimeIds));
    teeTimeIds.length = 0;
  }
  if (userIds.length > 0) {
    await db.delete(spectatorFollowsTable).where(inArray(spectatorFollowsTable.userId, userIds));
  }
  if (playerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, playerIds));
    playerIds.length = 0;
  }
  _resetSpectatorTeeOffDedupForTest();
  sendPushToUsersMock.mockClear();
});

describe("sendSpectatorTeeOffAlerts", () => {
  it("pushes only to opted-in followers and skips groups outside the [now+4m, now+10m] window", async () => {
    const now = Date.now();

    // In-window group with one player.
    const playerInWindow = await makePlayer("InWindow");
    await makeTeeTime(new Date(now + 7 * 60 * 1000), [playerInWindow]);

    // Out-of-window groups: too soon and too far.
    const playerTooSoon = await makePlayer("TooSoon");
    await makeTeeTime(new Date(now + 2 * 60 * 1000), [playerTooSoon]);
    const playerTooLate = await makePlayer("TooLate");
    await makeTeeTime(new Date(now + 30 * 60 * 1000), [playerTooLate]);

    // Followers: opted-in (should be notified) and opted-out (should be skipped).
    const optedInUser = await makeUser("optin");
    const optedOutUser = await makeUser("optout");
    await db.insert(spectatorFollowsTable).values({
      userId: optedInUser, tournamentId, playerId: playerInWindow, notifyTeeOff: true,
    });
    await db.insert(spectatorFollowsTable).values({
      userId: optedOutUser, tournamentId, playerId: playerInWindow, notifyTeeOff: false,
    });

    // Followers attached to out-of-window groups must NOT be notified.
    const irrelevantUser = await makeUser("irrelevant");
    await db.insert(spectatorFollowsTable).values({
      userId: irrelevantUser, tournamentId, playerId: playerTooSoon, notifyTeeOff: true,
    });
    await db.insert(spectatorFollowsTable).values({
      userId: irrelevantUser, tournamentId, playerId: playerTooLate, notifyTeeOff: true,
    });

    await sendSpectatorTeeOffAlerts();

    // Exactly one push call, only to the opted-in user.
    const ourTrioIds = [optedInUser, optedOutUser, irrelevantUser];
    const ourCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => ourTrioIds.includes(id)),
    );
    expect(ourCalls).toHaveLength(1);
    const [recipients, title, , data] = ourCalls[0]!;
    expect(recipients).toEqual([optedInUser]);
    expect(recipients).not.toContain(optedOutUser);
    expect(recipients).not.toContain(irrelevantUser);
    expect(title).toContain("Teeing off");
    expect((data as { type?: string }).type).toBe("spectator_tee_off");
  });

  it("does not re-push the same tee time on a second invocation (dedup)", async () => {
    const now = Date.now();
    const player = await makePlayer("Dedup");
    await makeTeeTime(new Date(now + 6 * 60 * 1000), [player]);
    const user = await makeUser("dedup_follower");
    await db.insert(spectatorFollowsTable).values({
      userId: user, tournamentId, playerId: player, notifyTeeOff: true,
    });

    await sendSpectatorTeeOffAlerts();
    let ourDedupCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === user),
    );
    expect(ourDedupCalls).toHaveLength(1);

    await sendSpectatorTeeOffAlerts();
    // Still 1 — the second pass deduped on teeTimeId.
    ourDedupCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === user),
    );
    expect(ourDedupCalls).toHaveLength(1);
  });

  it("survives a server restart: cleared in-memory dedup does not re-push the same group", async () => {
    const now = Date.now();
    const player = await makePlayer("RestartDedup");
    const teeTimeId = await makeTeeTime(new Date(now + 6 * 60 * 1000), [player]);
    const user = await makeUser("restart_follower");
    await db.insert(spectatorFollowsTable).values({
      userId: user, tournamentId, playerId: player, notifyTeeOff: true,
    });

    await sendSpectatorTeeOffAlerts();
    let ourRestartCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === user),
    );
    expect(ourRestartCalls).toHaveLength(1);

    // The persisted dedup mark should be present on the tee time row.
    const [tt] = await db
      .select({ alertedAt: teeTimesTable.spectatorTeeOffAlertedAt })
      .from(teeTimesTable)
      .where(eq(teeTimesTable.id, teeTimeId));
    expect(tt.alertedAt).not.toBeNull();

    // Simulate a server restart by clearing only the in-memory dedup set.
    // The persisted column on tee_times must be enough to prevent a re-push.
    _resetSpectatorTeeOffDedupForTest();

    await sendSpectatorTeeOffAlerts();
    // Still 1 — the persisted mark deduped across the simulated restart.
    ourRestartCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === user),
    );
    expect(ourRestartCalls).toHaveLength(1);
  });

  it("notifies tee-time-group followers (not just per-player follows) when opted in", async () => {
    const now = Date.now();
    const p1 = await makePlayer("GrpA");
    const p2 = await makePlayer("GrpB");
    const teeTimeId = await makeTeeTime(new Date(now + 8 * 60 * 1000), [p1, p2]);

    // Follow the entire tee-time group (no specific playerId).
    const groupFollower = await makeUser("group_follower");
    await db.insert(spectatorFollowsTable).values({
      userId: groupFollower, tournamentId, teeTimeId, notifyTeeOff: true,
    });

    // A second follower opted out at the group level — must be skipped.
    const groupOptOut = await makeUser("group_optout");
    await db.insert(spectatorFollowsTable).values({
      userId: groupOptOut, tournamentId, teeTimeId, notifyTeeOff: false,
    });

    await sendSpectatorTeeOffAlerts();

    // One push per player in the group (cron iterates each player), each
    // delivered to the group follower only.
    const ourGroupCalls = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === groupFollower || id === groupOptOut),
    );
    expect(ourGroupCalls).toHaveLength(2);
    for (const call of ourGroupCalls) {
      expect(call[0]).toEqual([groupFollower]);
      expect(call[0]).not.toContain(groupOptOut);
    }
  });
});
