/**
 * Task #1464 — Legacy `?days=N` query param still persists the wellness range.
 *
 * Task #1253 locked in the cross-device contract for the new `?rangeDays=N`
 * spelling, but `GET /portal/wellness/daily` also accepts the older `?days=N`
 * spelling (see the `rawRangeDays = req.query.rangeDays ?? req.query.days`
 * branch in `artifacts/api-server/src/routes/portal.ts`). Older mobile builds
 * and any lingering bookmarks still hit the legacy path, so a refactor that
 * accidentally drops it from the persistence branch would silently revert
 * those clients to the 30-day default on every other device.
 *
 * This test mirrors the cross-device flow in
 * `portal-wellness-range-days-cross-device.test.ts` but exercises the legacy
 * `?days=60` spelling: device A hits the legacy URL, then device B opens the
 * dashboard with no query param and must still receive `rangeDays: 60` and
 * `rangeDaysStored: true`, proving the upsert into
 * `user_health_prefs.wellness_range_days` happened.
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
      replitUserId: `t1464-player-${stamp}`,
      username: `t1464_player_${stamp}`,
      role: "player",
    })
    .returning({ id: appUsersTable.id });
  userId = u.id;
  actor = { id: userId, username: `t1464_player_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(userHealthPrefsTable).where(eq(userHealthPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
});

describe("GET /api/portal/wellness/daily — legacy ?days=N still persists range (Task #1464)", () => {
  it("persists ?days=60 from device A and serves it to device B with no query param", async () => {
    // Device A picks the 60-day range using the legacy `?days=N` spelling.
    const deviceA = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?days=60");
    expect(deviceA.status).toBe(200);
    expect(deviceA.body.rangeDays).toBe(60);
    expect(deviceA.body.rangeDaysStored).toBe(true);

    // The legacy path must upsert `user_health_prefs.wellness_range_days` so
    // other devices can pick it up — exactly like the new `?rangeDays=N` path.
    const [prefAfterA] = await db
      .select({ wellnessRangeDays: userHealthPrefsTable.wellnessRangeDays })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, userId));
    expect(prefAfterA?.wellnessRangeDays).toBe(60);

    // Device B opens the dashboard with no query param — the server must read
    // the stored preference and echo it back, NOT fall back to 30.
    const deviceB = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily");
    expect(deviceB.status).toBe(200);
    expect(deviceB.body.rangeDays).toBe(60);
    expect(deviceB.body.rangeDaysStored).toBe(true);
  });
});
