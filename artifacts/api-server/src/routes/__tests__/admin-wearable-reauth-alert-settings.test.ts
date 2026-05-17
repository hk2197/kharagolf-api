/**
 * Task #1580 — GET / PUT /api/admin/wearable-reauth-alert-settings
 *
 * Pins the HTTP contract on the admin settings endpoint that surfaces the
 * per-org WoW (week-over-week) re-auth drift threshold (`wowMinDelta`)
 * alongside the legacy needs_reauth alert thresholds.
 *
 * The `wowMinDelta` column was previously exercised only indirectly via the
 * `evaluateWeeklyReauthDrift` library tests. This file pins the wire
 * contract:
 *   • GET returns the per-org override (null when inheriting) plus the
 *     resolved global default exposed under `defaults.wowMinDelta`.
 *   • PUT accepts a positive number ≤ 9999.99 and rounds it to two decimals
 *     before persisting it as the column's `numeric(6, 2)` string value.
 *   • PUT clears the override (re-inherits the system-wide default) when the
 *     field is explicitly `null`.
 *   • PUT leaves the column untouched when the field is absent from the body
 *     (the back-compat case for callers that only update the legacy
 *     thresholds).
 *   • PUT rejects negatives, zero, > 9999.99, and non-numeric strings with
 *     a 400 — never quietly clamping or silently dropping the request.
 *   • Auth/permission gating: 401 unauthenticated, 403 for non-admin roles.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";
import { WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA } from "../../lib/wearables.js";

let orgId: number;
let adminId: number;
let playerId: number;
let superAdminId: number;
let envBefore: string | undefined;

beforeAll(async () => {
  // Pin the env-derived default so the assertions on the GET/PUT response
  // shape don't drift if the developer happens to have the env var set.
  envBefore = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
  delete process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T1580_${stamp}`,
    slug: `t1580-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `t1580-admin-${stamp}`,
    username: `t1580_admin_${stamp}`,
    email: `admin_${stamp}@t1580.test`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `t1580-player-${stamp}`,
    username: `t1580_player_${stamp}`,
    email: `player_${stamp}@t1580.test`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerId = player.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1580-super-${stamp}`,
    username: `t1580_super_${stamp}`,
    email: `super_${stamp}@t1580.test`,
    role: "super_admin",
    organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;
});

beforeEach(async () => {
  // Reset every test to a known baseline: legacy thresholds at their
  // hardcoded defaults, and the WoW override CLEARED so the next test
  // observes the inherited (env-derived) value unless it sets its own.
  await db.update(organizationsTable).set({
    wearableReauthAlertMinCount: 5,
    wearableReauthAlertMinSharePct: 25,
    wearableReauthAlertMinAttempted: 4,
    wearableReauthAlertEmail: null,
    wearableReauthWowAlertMinDelta: null,
  }).where(eq(organizationsTable.id, orgId));
});

afterAll(async () => {
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    adminId, playerId, superAdminId,
  ]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (envBefore === undefined) delete process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
  else process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA = envBefore;
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

const ENDPOINT = "/api/admin/wearable-reauth-alert-settings";

function getApp(user?: TestUser) {
  return createTestApp(user);
}

async function readDbWowMinDelta(): Promise<unknown> {
  const [row] = await db.select({
    v: organizationsTable.wearableReauthWowAlertMinDelta,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  return row?.v;
}

async function putValid(user: TestUser, overrides: Record<string, unknown> = {}) {
  return request(getApp(user)).put(ENDPOINT).send({
    minCount: 5,
    minSharePct: 25,
    minAttempted: 4,
    ...overrides,
  });
}

describe("GET /api/admin/wearable-reauth-alert-settings", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(getApp(undefined)).get(ENDPOINT);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await request(getApp(asUser(playerId, "player", orgId))).get(ENDPOINT);
    expect(res.status).toBe(403);
  });

  it("returns null wowMinDelta override and the system-wide default when the org has no override", async () => {
    const res = await request(getApp(asUser(adminId, "org_admin", orgId))).get(ENDPOINT);
    expect(res.status).toBe(200);
    const body = res.body as {
      orgId: number;
      settings: {
        wowMinDelta: number | null;
        wowMinDeltaEffective: number;
      };
      defaults: { wowMinDelta: number };
    };
    expect(body.orgId).toBe(orgId);
    // No override set in beforeEach → null override + effective falls back to default.
    expect(body.settings.wowMinDelta).toBeNull();
    expect(body.defaults.wowMinDelta).toBe(WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA);
    expect(body.settings.wowMinDeltaEffective).toBe(WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA);
  });

  it("returns the per-org wowMinDelta override as a number when one is set", async () => {
    // Seed an explicit override directly in the DB so the GET path is
    // tested in isolation from the PUT path.
    await db.update(organizationsTable).set({
      wearableReauthWowAlertMinDelta: "2.50",
    }).where(eq(organizationsTable.id, orgId));

    const res = await request(getApp(asUser(adminId, "org_admin", orgId))).get(ENDPOINT);
    expect(res.status).toBe(200);
    const body = res.body as {
      settings: { wowMinDelta: number | null; wowMinDeltaEffective: number };
      defaults: { wowMinDelta: number };
    };
    expect(body.settings.wowMinDelta).toBe(2.5);
    // Effective resolves to the override, not the inherited default.
    expect(body.settings.wowMinDeltaEffective).toBe(2.5);
    // Default is still surfaced so the UI can render an "inherits X" hint.
    expect(body.defaults.wowMinDelta).toBe(WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA);
  });

  it("allows super_admin to read another org's settings", async () => {
    // Seed a recognizable override on the org so we can assert the
    // super_admin path returns the same shape as the org_admin path.
    await db.update(organizationsTable).set({
      wearableReauthWowAlertMinDelta: "3.75",
    }).where(eq(organizationsTable.id, orgId));

    // Super admins are routed to whatever organization context the request
    // carries (here we inject `orgId` as the active org).
    const res = await request(getApp(asUser(superAdminId, "super_admin", orgId))).get(ENDPOINT);
    expect(res.status).toBe(200);
    const body = res.body as {
      orgId: number;
      settings: { wowMinDelta: number | null; wowMinDeltaEffective: number };
    };
    expect(body.orgId).toBe(orgId);
    expect(body.settings.wowMinDelta).toBe(3.75);
    expect(body.settings.wowMinDeltaEffective).toBe(3.75);
  });

  it("returns the env-derived default when the env var overrides the hardcoded one", async () => {
    process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA = "3.5";
    try {
      const res = await request(getApp(asUser(adminId, "org_admin", orgId))).get(ENDPOINT);
      expect(res.status).toBe(200);
      const body = res.body as {
        settings: { wowMinDelta: number | null; wowMinDeltaEffective: number };
        defaults: { wowMinDelta: number };
      };
      expect(body.defaults.wowMinDelta).toBe(3.5);
      // No org override → effective is the env-derived default.
      expect(body.settings.wowMinDelta).toBeNull();
      expect(body.settings.wowMinDeltaEffective).toBe(3.5);
    } finally {
      delete process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    }
  });
});

describe("PUT /api/admin/wearable-reauth-alert-settings — wowMinDelta happy path", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(getApp(undefined)).put(ENDPOINT).send({
      minCount: 5, minSharePct: 25, minAttempted: 4, wowMinDelta: 2,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await putValid(asUser(playerId, "player", orgId), { wowMinDelta: 2 });
    expect(res.status).toBe(403);
  });

  it("accepts a valid positive number and persists it as a numeric(6,2) string", async () => {
    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: 2 });
    expect(res.status).toBe(200);
    const body = res.body as {
      settings: { wowMinDelta: number | null; wowMinDeltaEffective: number };
    };
    // Response surfaces the override as a number for the UI's convenience.
    expect(body.settings.wowMinDelta).toBe(2);
    expect(body.settings.wowMinDeltaEffective).toBe(2);
    // Column round-trips as a 2-decimal string (numeric(6, 2)).
    expect(await readDbWowMinDelta()).toBe("2.00");
  });

  it("allows super_admin to update an org's wowMinDelta override", async () => {
    const res = await putValid(asUser(superAdminId, "super_admin", orgId), { wowMinDelta: 5.5 });
    expect(res.status).toBe(200);
    const body = res.body as { settings: { wowMinDelta: number | null } };
    expect(body.settings.wowMinDelta).toBe(5.5);
    expect(await readDbWowMinDelta()).toBe("5.50");
  });

  it("rounds an over-precise input to two decimals before persisting", async () => {
    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: 1.236 });
    expect(res.status).toBe(200);
    const body = res.body as { settings: { wowMinDelta: number | null } };
    expect(body.settings.wowMinDelta).toBe(1.24);
    expect(await readDbWowMinDelta()).toBe("1.24");
  });

  it("rounds half-down inputs symmetrically (1.234 → 1.23)", async () => {
    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: 1.234 });
    expect(res.status).toBe(200);
    expect(await readDbWowMinDelta()).toBe("1.23");
  });

  it("accepts the upper boundary value 9999.99", async () => {
    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: 9999.99 });
    expect(res.status).toBe(200);
    const body = res.body as { settings: { wowMinDelta: number | null } };
    expect(body.settings.wowMinDelta).toBe(9999.99);
    expect(await readDbWowMinDelta()).toBe("9999.99");
  });

  it("accepts a numeric string (e.g. '2.5') and rounds/persists it the same way", async () => {
    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: "2.5" });
    expect(res.status).toBe(200);
    const body = res.body as { settings: { wowMinDelta: number | null } };
    expect(body.settings.wowMinDelta).toBe(2.5);
    expect(await readDbWowMinDelta()).toBe("2.50");
  });

  it("clears the override (re-inherits the default) when wowMinDelta is explicitly null", async () => {
    // First seed an override so we can prove the clear actually mutates state.
    await db.update(organizationsTable).set({
      wearableReauthWowAlertMinDelta: "7.50",
    }).where(eq(organizationsTable.id, orgId));
    expect(await readDbWowMinDelta()).toBe("7.50");

    const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: null });
    expect(res.status).toBe(200);
    const body = res.body as {
      settings: { wowMinDelta: number | null; wowMinDeltaEffective: number };
    };
    expect(body.settings.wowMinDelta).toBeNull();
    // Effective falls back to the inherited (hardcoded) default.
    expect(body.settings.wowMinDeltaEffective).toBe(WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA);
    expect(await readDbWowMinDelta()).toBeNull();
  });

  it("leaves the existing override untouched when the field is absent from the body", async () => {
    // Seed an override; PUT without the wowMinDelta field must NOT clear it.
    await db.update(organizationsTable).set({
      wearableReauthWowAlertMinDelta: "4.20",
    }).where(eq(organizationsTable.id, orgId));

    const res = await putValid(asUser(adminId, "org_admin", orgId)); // no wowMinDelta key.
    expect(res.status).toBe(200);
    const body = res.body as { settings: { wowMinDelta: number | null } };
    expect(body.settings.wowMinDelta).toBe(4.2);
    // DB value unchanged.
    expect(await readDbWowMinDelta()).toBe("4.20");
  });
});

describe("PUT /api/admin/wearable-reauth-alert-settings — wowMinDelta validation failures", () => {
  const cases: Array<{ label: string; value: unknown }> = [
    { label: "negative number", value: -1 },
    { label: "negative string", value: "-2.5" },
    { label: "zero", value: 0 },
    { label: "rounds to zero (0.001 → 0.00)", value: 0.001 },
    { label: "above the upper boundary (10000)", value: 10000 },
    { label: "above the upper boundary (9999.999 rounds to 10000)", value: 9999.999 },
    { label: "non-numeric string", value: "not-a-number" },
    { label: "empty string", value: "" },
    { label: "object", value: { foo: "bar" } },
    { label: "array", value: [1, 2] },
    { label: "NaN serialized as string", value: "NaN" },
  ];

  for (const c of cases) {
    it(`rejects ${c.label} with 400 and leaves the DB value untouched`, async () => {
      // Seed a known prior value so we can assert non-mutation on failure.
      await db.update(organizationsTable).set({
        wearableReauthWowAlertMinDelta: "1.50",
      }).where(eq(organizationsTable.id, orgId));

      const res = await putValid(asUser(adminId, "org_admin", orgId), { wowMinDelta: c.value });
      expect(res.status).toBe(400);
      const body = res.body as { error?: string };
      expect(body.error ?? "").toMatch(/wowMinDelta/i);
      // Failure path must not mutate the column.
      expect(await readDbWowMinDelta()).toBe("1.50");
    });
  }
});
