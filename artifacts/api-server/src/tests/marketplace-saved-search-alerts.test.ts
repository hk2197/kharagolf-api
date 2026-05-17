/**
 * Test: marketplace saved-search alert worker (`runSavedSearchAlerts`).
 *
 * Verifies (Task #529 / Task 408):
 *   1. The worker only sends pushes for newly-matching slots.
 *   2. Re-running with no new slots produces zero new alerts (idempotent
 *      via the `(search_id, slot_id)` unique index).
 *   3. Exceeding the per-user daily cap trims notifications and logs a skip.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ): Promise<void> => undefined,
  ),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  marketplaceSlotsTable,
  marketplaceSavedSearchesTable,
  marketplaceSavedSearchAlertsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// Imported AFTER vi.mock so the route picks up the mocked comms module.
const { runSavedSearchAlerts, MARKETPLACE_ALERT_DAILY_CAP_PER_USER } =
  await import("../routes/marketplace-discover.js");

let testOrgId: number;
const userIds: number[] = [];
const slotIds: number[] = [];
const searchIds: number[] = [];

async function makeUser(suffix: string): Promise<number> {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `mkt-alert-${suffix}-${ts}`,
    username: `mkt_alert_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `MktAlert ${suffix}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeSlot(opts?: {
  daysAhead?: number;
  isPublic?: boolean;
  status?: string;
  pricePaise?: number;
  maxPlayers?: number;
  bookedPlayers?: number;
}): Promise<number> {
  const daysAhead = opts?.daysAhead ?? 1;
  const [s] = await db.insert(marketplaceSlotsTable).values({
    organizationId: testOrgId,
    slotDate: new Date(Date.now() + daysAhead * 86_400_000),
    startingHole: 1,
    maxPlayers: opts?.maxPlayers ?? 4,
    bookedPlayers: opts?.bookedPlayers ?? 0,
    pricePaise: opts?.pricePaise ?? 50000,
    isPublic: opts?.isPublic ?? true,
    status: opts?.status ?? "open",
  }).returning({ id: marketplaceSlotsTable.id });
  slotIds.push(s.id);
  return s.id;
}

async function makeSavedSearch(userId: number, name: string, filters: object = {}, notifyEnabled = true): Promise<number> {
  const [r] = await db.insert(marketplaceSavedSearchesTable).values({
    userId, name, filters, notifyEnabled,
  }).returning({ id: marketplaceSavedSearchesTable.id });
  searchIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktAlertOrg_${ts}`,
    slug: `mkt-alert-${ts}`,
    marketplaceEnabled: true,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  if (searchIds.length > 0) {
    await db.delete(marketplaceSavedSearchAlertsTable).where(inArray(marketplaceSavedSearchAlertsTable.searchId, searchIds));
    await db.delete(marketplaceSavedSearchesTable).where(inArray(marketplaceSavedSearchesTable.id, searchIds));
  }
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
  }
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  // Wipe per-test state so each scenario starts clean.
  if (searchIds.length > 0) {
    await db.delete(marketplaceSavedSearchAlertsTable).where(inArray(marketplaceSavedSearchAlertsTable.searchId, searchIds));
    await db.delete(marketplaceSavedSearchesTable).where(inArray(marketplaceSavedSearchesTable.id, searchIds));
    searchIds.length = 0;
  }
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
    slotIds.length = 0;
  }
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
    userIds.length = 0;
  }
  sendTransactionalPushMock.mockClear();
});

describe("runSavedSearchAlerts", () => {
  it("sends one push per saved search with newly-matching public slots and records alert rows", async () => {
    const user = await makeUser("matcher");

    // Two public open slots that satisfy a wide-open search, plus a non-matching
    // slot (private) that must be ignored.
    const slot1 = await makeSlot({ daysAhead: 1 });
    const slot2 = await makeSlot({ daysAhead: 2 });
    await makeSlot({ daysAhead: 3, isPublic: false }); // ignored: not public
    await makeSlot({ daysAhead: 4, status: "closed" }); // ignored: not open
    await makeSlot({ daysAhead: 5, maxPlayers: 4, bookedPlayers: 4 }); // ignored: full

    const searchId = await makeSavedSearch(user, "any tee time", {});

    const result = await runSavedSearchAlerts();

    expect(result.searchesEvaluated).toBe(1);
    expect(result.notifications).toBe(2);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, , data] = sendTransactionalPushMock.mock.calls[0];
    expect(recipients).toEqual([user]);
    expect(title).toContain("2 new tee times");
    expect((data as { type?: string; savedSearchId?: number; slotIds?: number[] }))
      .toMatchObject({ type: "marketplace_saved_search_match", savedSearchId: searchId });
    expect(((data as { slotIds: number[] }).slotIds).sort()).toEqual([slot1, slot2].sort());

    const recorded = await db.select()
      .from(marketplaceSavedSearchAlertsTable)
      .where(eq(marketplaceSavedSearchAlertsTable.searchId, searchId));
    expect(recorded.map((r) => r.slotId).sort()).toEqual([slot1, slot2].sort());
  });

  it("is idempotent: a second run with no new slots produces zero new alerts", async () => {
    const user = await makeUser("idempotent");
    await makeSlot({ daysAhead: 1 });
    await makeSlot({ daysAhead: 2 });
    const searchId = await makeSavedSearch(user, "idem search", {});

    const first = await runSavedSearchAlerts();
    expect(first.notifications).toBe(2);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);

    sendTransactionalPushMock.mockClear();

    const second = await runSavedSearchAlerts();
    expect(second.notifications).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    // Add one brand-new slot — only that one should produce an alert.
    const newSlot = await makeSlot({ daysAhead: 3 });
    const third = await runSavedSearchAlerts();
    expect(third.notifications).toBe(1);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [, title, , data] = sendTransactionalPushMock.mock.calls[0];
    expect(title).toContain("1 new tee time");
    expect((data as { slotIds: number[] }).slotIds).toEqual([newSlot]);

    // The unique (search_id, slot_id) index keeps total rows = unique slots seen.
    const recorded = await db.select()
      .from(marketplaceSavedSearchAlertsTable)
      .where(eq(marketplaceSavedSearchAlertsTable.searchId, searchId));
    expect(recorded.length).toBe(3);
  });

  it("trims new alerts to the per-user daily cap and logs a skip on the next run", async () => {
    const cap = MARKETPLACE_ALERT_DAILY_CAP_PER_USER;
    expect(cap).toBeGreaterThan(0);

    const user = await makeUser("capped");

    // Seed (cap + 3) matching slots; the worker must trim down to `cap` and
    // record only that many alert rows on the first run.
    const totalSlots = cap + 3;
    const allSlotIds: number[] = [];
    for (let i = 0; i < totalSlots; i++) {
      allSlotIds.push(await makeSlot({ daysAhead: i + 1 }));
    }
    const searchId = await makeSavedSearch(user, "broad search", {});

    const first = await runSavedSearchAlerts();
    expect(first.notifications).toBe(cap);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [, title] = sendTransactionalPushMock.mock.calls[0];
    expect(title).toContain(`${cap} new tee time`);

    const afterFirst = await db.select()
      .from(marketplaceSavedSearchAlertsTable)
      .where(eq(marketplaceSavedSearchAlertsTable.searchId, searchId));
    expect(afterFirst.length).toBe(cap);

    sendTransactionalPushMock.mockClear();

    // A second run finds the remaining 3 unalerted slots, but the user has
    // already received `cap` notifications in the last 24h, so the worker
    // must skip the search entirely and emit zero pushes.
    const second = await runSavedSearchAlerts();
    expect(second.notifications).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    const afterSecond = await db.select()
      .from(marketplaceSavedSearchAlertsTable)
      .where(eq(marketplaceSavedSearchAlertsTable.searchId, searchId));
    expect(afterSecond.length).toBe(cap);
  });

  it("ignores searches with notifyEnabled = false", async () => {
    const user = await makeUser("disabled");
    await makeSlot({ daysAhead: 1 });
    await makeSavedSearch(user, "disabled search", {}, false);

    const result = await runSavedSearchAlerts();
    expect(result.searchesEvaluated).toBe(0);
    expect(result.notifications).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
  });
});
