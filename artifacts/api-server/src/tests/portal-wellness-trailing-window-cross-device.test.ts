/**
 * Task #1092 — Cross-device persistence of the wellness trailing-round window.
 *
 * The wellness dashboard's scoring-average overlay lets the player pick how
 * many trailing rounds to average over (3 / 5 / 10 / 20). Task #946 moved that
 * choice from per-device AsyncStorage onto `user_health_prefs.wellness_trailing_window`
 * so it follows the player across devices and reinstalls.
 *
 * This test locks in the cross-device contract end-to-end against the live
 * route: picking 10-rd on one client (request #1) and then opening the
 * dashboard with no query param (request #2 — simulating a different device
 * that has no local cache) must return `trailingWindow: 10` and the stored
 * preference row must reflect 10.
 *
 * It also covers the rejection path: an out-of-range value (7) must NOT
 * overwrite the previously stored 10.
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
      replitUserId: `t1092-player-${stamp}`,
      username: `t1092_player_${stamp}`,
      role: "player",
    })
    .returning({ id: appUsersTable.id });
  userId = u.id;
  actor = { id: userId, username: `t1092_player_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
});

describe("GET /api/portal/wellness/daily — trailing-window cross-device persistence (Task #1092)", () => {
  it("persists ?trailingWindow=10 from device A and serves it to device B with no query param", async () => {
    // Device A picks 10-rd.
    const deviceA = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?trailingWindow=10");
    expect(deviceA.status).toBe(200);
    expect(deviceA.body.trailingWindow).toBe(10);
    expect(deviceA.body.trailingWindowStored).toBe(true);

    // Stored on user_health_prefs.
    const [prefAfterA] = await db
      .select({ wellnessTrailingWindow: userHealthPrefsTable.wellnessTrailingWindow })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, userId));
    expect(prefAfterA?.wellnessTrailingWindow).toBe(10);

    // Device B opens the dashboard with no trailingWindow param — the server
    // must read the stored preference and echo it back.
    const deviceB = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily");
    expect(deviceB.status).toBe(200);
    expect(deviceB.body.trailingWindow).toBe(10);
    expect(deviceB.body.trailingWindowStored).toBe(true);
  });

  it("rejects out-of-range values (e.g. trailingWindow=7) without overwriting the stored preference", async () => {
    // Self-contained precondition: explicitly seed the stored value as 10 so
    // this test does not depend on the previous test's side effects.
    await db
      .insert(userHealthPrefsTable)
      .values({ userId, wellnessTrailingWindow: 10 })
      .onConflictDoUpdate({
        target: userHealthPrefsTable.userId,
        set: { wellnessTrailingWindow: 10, updatedAt: new Date() },
      });

    const bad = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?trailingWindow=7");
    expect(bad.status).toBe(200);
    // Falls back to the stored value, NOT to 7 and NOT to the default 5.
    expect(bad.body.trailingWindow).toBe(10);
    expect(bad.body.trailingWindowStored).toBe(true);

    // The DB row is unchanged.
    const [pref] = await db
      .select({ wellnessTrailingWindow: userHealthPrefsTable.wellnessTrailingWindow })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, userId));
    expect(pref?.wellnessTrailingWindow).toBe(10);
  });
});
