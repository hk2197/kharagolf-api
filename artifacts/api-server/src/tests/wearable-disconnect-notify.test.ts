/**
 * Test: one-time push when a wearable connection flips to needs_reauth
 * (Task #692).
 *
 * Verifies the player-facing reauth notification:
 *   - First time refreshWhoopToken / refreshGoogleFitToken flips status from
 *     "connected" -> "needs_reauth", a single push is sent with
 *     type='wearable_disconnected' and the failing provider.
 *   - A second invocation against an already-flipped connection is a no-op:
 *     no extra push is fired (so repeated sweeps don't re-spam the player).
 *   - When no connection row exists, no push is sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(async () => ({
    attempted: 1, sent: 1, failed: 0, invalid: 0,
  })),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

import { db, appUsersTable, wearableConnectionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { refreshWhoopToken, refreshGoogleFitToken } from "../lib/wearables.js";

const ORIG_ENV = {
  WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  GOOGLE_FIT_CLIENT_ID: process.env.GOOGLE_FIT_CLIENT_ID,
  GOOGLE_FIT_CLIENT_SECRET: process.env.GOOGLE_FIT_CLIENT_SECRET,
};

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const createdUserIds: number[] = [];

async function newUser(label: string): Promise<number> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wearable-disc-${label}-${stamp}`,
    username: `wearable_disc_${label}_${stamp}`,
    role: "player",
  }).returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function getConn(userId: number, provider: "whoop" | "google_fit") {
  const [row] = await db.select()
    .from(wearableConnectionsTable)
    .where(and(
      eq(wearableConnectionsTable.userId, userId),
      eq(wearableConnectionsTable.provider, provider),
    ));
  return row;
}

beforeAll(() => {
  process.env.WHOOP_CLIENT_ID = "test-whoop-client";
  process.env.WHOOP_CLIENT_SECRET = "test-whoop-secret";
  process.env.GOOGLE_FIT_CLIENT_ID = "test-gfit-client";
  process.env.GOOGLE_FIT_CLIENT_SECRET = "test-gfit-secret";
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const id of createdUserIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("wearable disconnect push notification", () => {
  it("fires exactly one push the first time Whoop refresh flips to needs_reauth, and no push on subsequent flips", async () => {
    const userId = await newUser("whoop");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "stale",
      refreshToken: "expired-refresh",
      tokenExpiresAt: new Date(Date.now() - 60_000),
      // lastSyncAt=now keeps this row out of the parallel wellness-sweep test
      // (24h dedupe) so we don't introduce cross-file test pollution.
      lastSyncAt: new Date(),
    });

    fetchMock.mockImplementation(async () => new Response("invalid_grant", { status: 401 }));

    // First flip: connected -> needs_reauth, expect one push.
    const conn1 = await getConn(userId, "whoop");
    const out1 = await refreshWhoopToken(conn1);
    expect(out1).toBeNull();

    const after1 = await getConn(userId, "whoop");
    expect(after1.status).toBe("needs_reauth");

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const call1 = sendPushToUsersMock.mock.calls[0] as unknown as [number[], string, string, Record<string, unknown>];
    expect(call1[0]).toEqual([userId]);
    expect(call1[1]).toBe("Wearable disconnected");
    expect(call1[2]).toContain("Whoop");
    expect(call1[3]).toMatchObject({
      type: "wearable_disconnected",
      provider: "whoop",
      screen: "profile",
    });

    // Second flip: row is already needs_reauth, no extra push.
    const conn2 = await getConn(userId, "whoop");
    const out2 = await refreshWhoopToken(conn2);
    expect(out2).toBeNull();
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
  });

  it("fires the push for Google Fit too, with provider=google_fit", async () => {
    const userId = await newUser("gfit");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "google_fit",
      status: "connected",
      accessToken: "stale",
      refreshToken: "revoked-refresh",
      tokenExpiresAt: new Date(Date.now() - 60_000),
      lastSyncAt: new Date(), // keep out of parallel sweep — see whoop test
    });

    fetchMock.mockImplementation(async () => new Response("forbidden", { status: 403 }));

    const conn = await getConn(userId, "google_fit");
    const out = await refreshGoogleFitToken(conn);
    expect(out).toBeNull();

    const after = await getConn(userId, "google_fit");
    expect(after.status).toBe("needs_reauth");

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const call = sendPushToUsersMock.mock.calls[0] as unknown as [number[], string, string, Record<string, unknown>];
    expect(call[2]).toContain("Google Fit");
    expect(call[3]).toMatchObject({
      type: "wearable_disconnected",
      provider: "google_fit",
      screen: "profile",
    });
  });

  it("only one push fires when many refreshWhoopToken calls race in parallel", async () => {
    const userId = await newUser("race");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "stale",
      refreshToken: "expired-refresh",
      tokenExpiresAt: new Date(Date.now() - 60_000),
      lastSyncAt: new Date(),
    });

    fetchMock.mockImplementation(async () => new Response("invalid_grant", { status: 401 }));

    const conn = await getConn(userId, "whoop");
    // Five concurrent failed refreshes — the conditional UPDATE should
    // ensure exactly one wins the flip, and only that caller sends the push.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refreshWhoopToken(conn)),
    );
    expect(results.every(r => r === null)).toBe(true);

    const after = await getConn(userId, "whoop");
    expect(after.status).toBe("needs_reauth");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a push when there is no connection row to flip", async () => {
    const userId = await newUser("noconn");
    // refreshWhoopToken short-circuits when conn.refreshToken is null and
    // calls markConnectionNeedsReauth("no refresh token"); but since we never
    // inserted a connection row, that helper finds nothing and must no-op.
    const fakeConn = {
      userId,
      provider: "whoop" as const,
      refreshToken: null,
      accessToken: null,
      tokenExpiresAt: null,
    } as unknown as Parameters<typeof refreshWhoopToken>[0];
    const out = await refreshWhoopToken(fakeConn);
    expect(out).toBeNull();
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });
});
