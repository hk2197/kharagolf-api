/**
 * Test: tournament 24h / 1h tee-off reminder cron (Task #796).
 *
 * Verifies that both `send24hReminders` and `send1hReminders` survive a
 * server restart that happens inside their polling window: the persisted
 * `reminder_24h_sent_at` / `reminder_1h_sent_at` columns must prevent a
 * second push even after the in-memory dedup `Set`s have been cleared.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * The api-server vitest suite runs in a single fork against a shared
 * dev DB and `send24hReminders`/`send1hReminders` sweep `tournaments`
 * globally. Unscoped `mock).toHaveBeenCalledTimes(N)` totals would
 * flake the moment a sibling cron test seeds an upcoming tournament
 * matching the same window, so this file filters `sendPushToUsersMock`
 * calls by the spectator userIds we own.
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
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  send24hReminders,
  send1hReminders,
  _resetTournamentReminderDedupForTest,
} from "../lib/cron.js";

let testOrgId: number;
const tournamentIds: number[] = [];
const userIds: number[] = [];
const playerIds: number[] = [];

async function makeUser(suffix: string) {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `tourn-rem-${suffix}-${ts}`,
    username: `tourn_rem_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `Player ${suffix}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeTournament(startDate: Date) {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    name: `TournRem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    status: "upcoming",
    startDate,
    autoReminder: true,
  }).returning({ id: tournamentsTable.id });
  tournamentIds.push(t.id);
  return t.id;
}

async function makePlayer(tournamentId: number, userId: number) {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId,
    firstName: "Test",
    lastName: "Player",
  }).returning({ id: playersTable.id });
  playerIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TournRemOrg_${ts}`,
    slug: `tourn-rem-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  if (playerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, playerIds));
  }
  if (tournamentIds.length > 0) {
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
  }
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  _resetTournamentReminderDedupForTest();
  sendPushToUsersMock.mockClear();
});

describe("send24hReminders — restart-survives dedup", () => {
  it("does not re-push after a simulated restart inside the polling window", async () => {
    // Tournament that starts in ~24h (well inside the [23h, 25h] window).
    const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tournamentId = await makeTournament(startDate);
    const userId = await makeUser("24h");
    await makePlayer(tournamentId, userId);

    await send24hReminders();
    const ourCalls24a = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === userId),
    );
    expect(ourCalls24a).toHaveLength(1);
    expect(ourCalls24a[0]![0]).toEqual([userId]);

    // Persisted dedup mark should now be set on the tournament row.
    const [row] = await db
      .select({ sentAt: tournamentsTable.reminder24hSentAt })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));
    expect(row.sentAt).not.toBeNull();

    // Simulate an API server restart by clearing only the in-memory dedup
    // set. The persisted column on tournaments must keep us deduped.
    _resetTournamentReminderDedupForTest();

    await send24hReminders();
    const ourCalls24b = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === userId),
    );
    expect(ourCalls24b).toHaveLength(1);
  });
});

describe("send1hReminders — restart-survives dedup", () => {
  it("does not re-push after a simulated restart inside the polling window", async () => {
    // Tournament that starts in ~1h (inside the [45m, 75m] window).
    const startDate = new Date(Date.now() + 60 * 60 * 1000);
    const tournamentId = await makeTournament(startDate);
    const userId = await makeUser("1h");
    await makePlayer(tournamentId, userId);

    await send1hReminders();
    const ourCalls1ha = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === userId),
    );
    expect(ourCalls1ha).toHaveLength(1);
    expect(ourCalls1ha[0]![0]).toEqual([userId]);

    const [row] = await db
      .select({ sentAt: tournamentsTable.reminder1hSentAt })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));
    expect(row.sentAt).not.toBeNull();

    _resetTournamentReminderDedupForTest();

    await send1hReminders();
    const ourCalls1hb = sendPushToUsersMock.mock.calls.filter(c =>
      (c[0] as number[]).some(id => id === userId),
    );
    expect(ourCalls1hb).toHaveLength(1);
  });
});
