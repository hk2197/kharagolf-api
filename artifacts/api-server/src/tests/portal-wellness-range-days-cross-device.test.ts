/**
 * Task #1253 — Cross-device persistence of the wellness dashboard's visible
 * range (30 / 60 / 90 days).
 *
 * Task #1091 moved the range selector off per-device AsyncStorage onto
 * `user_health_prefs.wellness_range_days` so the choice follows the player
 * across devices and reinstalls. This test locks in the cross-device contract
 * end-to-end against the live route:
 *
 *   1. Picking 60-d on one client (request #1) and then opening the dashboard
 *      with no query param (request #2 — simulating a different device that
 *      has no local cache) must return `rangeDays: 60` with
 *      `rangeDaysStored: true`, and the stored preference row must reflect 60.
 *   2. An out-of-allow-list value (45) must NOT persist and the response's
 *      `rangeDaysStored` flag must stay `false` so the client does not treat
 *      it as a server-confirmed choice.
 *
 * A regression in either path would silently fall the player back to the
 * default 30-day window on every other device.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { appUsersTable, userHealthPrefsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let userId: number;
let actor: TestUser;

beforeAll(async () => {
  const stamp = Date.now();
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `t1253-player-${stamp}`,
      username: `t1253_player_${stamp}`,
      role: "player",
    })
    .returning({ id: appUsersTable.id });
  userId = u.id;
  actor = { id: userId, username: `t1253_player_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
});

describe("GET /api/portal/wellness/daily — range-days cross-device persistence (Task #1253)", () => {
  it("persists ?rangeDays=60 from device A and serves it to device B with no query param", async () => {
    // Device A picks the 60-day range.
    const deviceA = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?rangeDays=60");
    expect(deviceA.status).toBe(200);
    expect(deviceA.body.rangeDays).toBe(60);
    expect(deviceA.body.rangeDaysStored).toBe(true);

    // Stored on user_health_prefs so other devices can pick it up.
    const [prefAfterA] = await db
      .select({ wellnessRangeDays: userHealthPrefsTable.wellnessRangeDays })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, userId));
    expect(prefAfterA?.wellnessRangeDays).toBe(60);

    // Device B opens the dashboard with no rangeDays param — the server must
    // read the stored preference and echo it back, NOT fall back to 30.
    const deviceB = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily");
    expect(deviceB.status).toBe(200);
    expect(deviceB.body.rangeDays).toBe(60);
    expect(deviceB.body.rangeDaysStored).toBe(true);
  });

  it("rejects out-of-allow-list values (e.g. rangeDays=45) without persisting them", async () => {
    // Self-contained precondition: explicitly seed the stored value as 60 so
    // this test does not depend on the previous test's side effects.
    await db
      .insert(userHealthPrefsTable)
      .values({ userId, wellnessRangeDays: 60 })
      .onConflictDoUpdate({
        target: userHealthPrefsTable.userId,
        set: { wellnessRangeDays: 60, updatedAt: new Date() },
      });

    const bad = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?rangeDays=45");
    expect(bad.status).toBe(200);
    // Out-of-allow-list values are honoured for the single response (legacy
    // ?days=N behaviour) but must NOT be marked as stored — the client uses
    // `rangeDaysStored: false` to know it should not treat 45 as the player's
    // server-confirmed choice.
    expect(bad.body.rangeDaysStored).toBe(false);

    // The DB row is unchanged: the previously stored 60 is still there.
    const [pref] = await db
      .select({ wellnessRangeDays: userHealthPrefsTable.wellnessRangeDays })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, userId));
    expect(pref?.wellnessRangeDays).toBe(60);
  });
});
