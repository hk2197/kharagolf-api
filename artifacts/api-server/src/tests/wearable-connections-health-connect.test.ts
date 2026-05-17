/**
 * Integration test: POST /api/portal/wearable-connections accepts
 * `provider: "health_connect"` (Task #659).
 *
 * This is the server-side counterpart of the Health Connect Android sync
 * (Task #540). The mobile bridge in
 * `artifacts/kharagolf-mobile/utils/healthConnect.ts` calls this endpoint
 * with `{ provider: "health_connect" }` once a sync writes at least one day
 * of data, so a regression in the `validProviders` list would silently
 * leave Android players without their "Health Connect connected" badge.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, appUsersTable, wearableConnectionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let testUserId: number;

beforeAll(async () => {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `health-connect-test-${Date.now()}`,
    username: `hc_test_${Date.now()}`,
    role: "player",
    // No organizationId — keeps the mobileApp feature gate in /portal/* a no-op.
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
});

describe("POST /api/portal/wearable-connections — health_connect provider", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/portal/wearable-connections")
      .send({ provider: "health_connect" });
    expect(res.status).toBe(401);
  });

  it("rejects requests missing provider with 400", async () => {
    const app = createTestApp({ id: testUserId, username: "hc_test", role: "player" });
    const res = await request(app)
      .post("/api/portal/wearable-connections")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider required/i);
  });

  it("rejects unknown providers with 400 and 'unknown provider'", async () => {
    const app = createTestApp({ id: testUserId, username: "hc_test", role: "player" });
    const res = await request(app)
      .post("/api/portal/wearable-connections")
      .send({ provider: "fitbit_galaxy_watch_xl" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown provider/i);
  });

  it("accepts provider: 'health_connect' and stores a connected row", async () => {
    const app = createTestApp({ id: testUserId, username: "hc_test", role: "player" });
    const res = await request(app)
      .post("/api/portal/wearable-connections")
      .send({ provider: "health_connect" });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("health_connect");
    expect(res.body.status).toBe("connected");
    expect(res.body.userId).toBe(testUserId);

    const rows = await db.select().from(wearableConnectionsTable).where(
      and(
        eq(wearableConnectionsTable.userId, testUserId),
        eq(wearableConnectionsTable.provider, "health_connect"),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("connected");
  });

  it("upserts on repeat calls (no duplicate row, status remains connected)", async () => {
    const app = createTestApp({ id: testUserId, username: "hc_test", role: "player" });
    // Two repeat calls — the unique (user_id, provider) index would throw if
    // the route did not use ON CONFLICT DO UPDATE, so this guards the upsert.
    const first = await request(app)
      .post("/api/portal/wearable-connections")
      .send({ provider: "health_connect" });
    const second = await request(app)
      .post("/api/portal/wearable-connections")
      .send({ provider: "health_connect" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await db.select().from(wearableConnectionsTable).where(
      and(
        eq(wearableConnectionsTable.userId, testUserId),
        eq(wearableConnectionsTable.provider, "health_connect"),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("connected");
  });
});
