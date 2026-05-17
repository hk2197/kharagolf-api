/**
 * Route-layer tests for GET /super-admin/ops-alert-settings/history
 * (Task #1924).
 *
 * The lib-layer pagination + filter behaviour is covered by
 * `ops-alert-settings-history.test.ts`. This file specifically
 * exercises the HTTP boundary the dashboard's "Show all" browser
 * talks to:
 *
 *   - 401/403 gating (super_admin only)
 *   - `limit` is clamped (oversized values do NOT 400)
 *   - `offset`, `from`, `to`, `editorId` validation (400 on bad input)
 *   - The response shape includes `entries`, `total`, `limit`, `offset`
 *     so the UI can render the page footer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db, opsAlertSettingsTable, opsAlertSettingsHistoryTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import {
  updateOpsAlertSettings,
  _resetOpsAlertSettingsCacheForTest,
} from "../lib/opsAlertSettings.js";

let superAdminUserId: number;
let nonAdminUserId: number;
const seededRowIds: number[] = [];
const tag = `ops-history-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const [su] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `${tag}-su`,
      username: `${tag}-su`,
      email: `${tag}-su@example.com`,
      role: "super_admin",
      displayName: "History Route Tester",
    })
    .returning({ id: appUsersTable.id });
  superAdminUserId = su.id;

  const [nu] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `${tag}-nu`,
      username: `${tag}-nu`,
      email: `${tag}-nu@example.com`,
      role: "player",
    })
    .returning({ id: appUsersTable.id });
  nonAdminUserId = nu.id;
});

afterAll(async () => {
  await db.delete(appUsersTable).where(eq(appUsersTable.id, superAdminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
});

beforeEach(async () => {
  _resetOpsAlertSettingsCacheForTest();
  await db.delete(opsAlertSettingsHistoryTable);
  seededRowIds.length = 0;
  await db
    .update(opsAlertSettingsTable)
    .set({
      notifyExhaustionThreshold: null,
      notifyExhaustionWindowHours: null,
      manualEntryRateThresholdPct: null,
      manualEntryMinSample: null,
      manualEntryConsecutiveZero: null,
      manualEntryCooldownHours: null,
      // Task #2081 — three additional manual-entry tunables. Reset
      // alongside the four legacy ones so each test starts from the
      // documented "everything inheriting from env / default" baseline.
      manualEntryLookbackHours: null,
      manualEntryDryRun: null,
      manualEntryRecipientLookupLimit: null,
      updatedByUserId: null,
    })
    .where(eq(opsAlertSettingsTable.id, 1));
});

describe("GET /api/super-admin/ops-alert-settings/history (Task #1924)", () => {
  it("rejects unauthenticated and non-super-admin callers", async () => {
    const anon = createTestApp();
    const r1 = await request(anon).get("/api/super-admin/ops-alert-settings/history");
    // requireSuperAdmin returns 401 / 403 — both are acceptable "blocked".
    expect([401, 403]).toContain(r1.status);

    const member = createTestApp({
      id: nonAdminUserId,
      username: `${tag}-nu`,
      role: "member",
    });
    const r2 = await request(member).get("/api/super-admin/ops-alert-settings/history");
    expect([401, 403]).toContain(r2.status);
  });

  it("returns { entries, total, limit, offset } for super admins (default page)", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: superAdminUserId,
      });
      expect(r.ok).toBe(true);
    }
    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const res = await request(app).get("/api/super-admin/ops-alert-settings/history");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 3,
      limit: 10, // default
      offset: 0,
    });
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries[0].newThreshold).toBe(3);
  });

  it("clamps oversized limit to OPS_ALERT_HISTORY_MAX_LIMIT instead of 400", async () => {
    for (let i = 1; i <= 2; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: superAdminUserId,
      });
      expect(r.ok).toBe(true);
    }
    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const res = await request(app)
      .get("/api/super-admin/ops-alert-settings/history?limit=99999");
    expect(res.status).toBe(200);
    // Server clamped to its hard cap (currently 100); we just assert the
    // returned `limit` is not the user-supplied value and the entries are
    // bounded.
    expect(res.body.limit).toBeLessThanOrEqual(100);
    expect(res.body.entries.length).toBeLessThanOrEqual(res.body.limit);
  });

  it("paginates with offset + limit", async () => {
    for (let i = 1; i <= 6; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: superAdminUserId,
      });
      expect(r.ok).toBe(true);
    }
    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const page1 = await request(app)
      .get("/api/super-admin/ops-alert-settings/history?limit=2&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(6);
    expect(page1.body.entries.map((e: { newThreshold: number }) => e.newThreshold)).toEqual([6, 5]);

    const page2 = await request(app)
      .get("/api/super-admin/ops-alert-settings/history?limit=2&offset=2");
    expect(page2.body.entries.map((e: { newThreshold: number }) => e.newThreshold)).toEqual([4, 3]);

    const page4 = await request(app)
      .get("/api/super-admin/ops-alert-settings/history?limit=2&offset=100");
    expect(page4.body.entries).toEqual([]);
    expect(page4.body.total).toBe(6);
  });

  it("400s on malformed offset / limit / from / to / editorId", async () => {
    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const cases = [
      "limit=abc",
      "offset=abc",
      "offset=-3",
      "from=not-a-date",
      "to=not-a-date",
      "editorId=abc",
      "editorId=-1",
      "editorId=1.5",
    ];
    for (const q of cases) {
      const res = await request(app)
        .get(`/api/super-admin/ops-alert-settings/history?${q}`);
      expect(res.status, `expected 400 for ?${q}, got ${res.status}`).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
  });

  it("400s when from is after to", async () => {
    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const res = await request(app).get(
      "/api/super-admin/ops-alert-settings/history?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z",
    );
    expect(res.status).toBe(400);
  });

  it("filters by editorId='none' to return only system-attributed rows", async () => {
    // One write attributed, one with userId=null (system).
    const r1 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 1,
      userId: superAdminUserId,
    });
    expect(r1.ok).toBe(true);
    const r2 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 2,
      userId: null,
    });
    expect(r2.ok).toBe(true);

    const app = createTestApp({
      id: superAdminUserId,
      username: `${tag}-su`,
      role: "super_admin",
    });
    const res = await request(app)
      .get("/api/super-admin/ops-alert-settings/history?editorId=none");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].changedByUserId).toBeNull();
    expect(res.body.entries[0].newThreshold).toBe(2);
  });
});
