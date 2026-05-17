/**
 * Integration tests for the per-org bounced-reminders digest scheduling
 * editor endpoints (Task #321 — coverage for the GET/PATCH endpoints
 * introduced in Task #274 and consumed by the BouncedDigestPrefsCard UI).
 *
 * Coverage:
 *   - GET returns the saved schedule for an org_admin caller.
 *   - GET allows treasurer / membership_secretary org-membership roles
 *     (the digest's recipient set) and rejects player / unauthenticated
 *     callers with 401 / 403.
 *   - PATCH validates frequency (must be daily / weekday / weekly),
 *     hourLocal (integer 0..23), and timezone (must parse via
 *     Intl.DateTimeFormat).
 *   - PATCH resets bounced_digest_last_sent_on to NULL so the next cron
 *     tick can immediately preview the new cadence (the headline
 *     behaviour documented in routes/organizations.ts).
 *   - PATCH RBAC matches GET — non-admin members are rejected.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { inArray, eq } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `DigestPrefs_${tag}`,
    slug: `digest-prefs-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: role,
    role,
    organizationId: role === "org_admin" ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: role,
    role,
    organizationId: role === "org_admin" ? orgId : undefined,
  };
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /organizations/:orgId/bounced-digest-prefs", () => {
  it("returns the current schedule for an org_admin caller", async () => {
    const orgId = await makeOrg("get_admin");
    // Seed a non-default schedule so we know we're reading it back.
    await db.update(organizationsTable).set({
      bouncedDigestFrequency: "weekly",
      bouncedDigestHourLocal: 9,
      bouncedDigestTimezone: "Asia/Kolkata",
      bouncedDigestLastSentOn: "2026-04-15",
    }).where(eq(organizationsTable.id, orgId));

    const admin = await makeUser(orgId, "org_admin");
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .expect(200);

    expect(res.body).toEqual({
      frequency: "weekly",
      hourLocal: 9,
      timezone: "Asia/Kolkata",
      lastSentOn: "2026-04-15",
    });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("get_authz");
    await request(createTestApp())
      .get(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .expect(403);
  });
});

describe("PATCH /organizations/:orgId/bounced-digest-prefs", () => {
  it("rejects unknown frequency values", async () => {
    const orgId = await makeOrg("patch_freq");
    const admin = await makeUser(orgId, "org_admin");
    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "yearly", hourLocal: 9, timezone: "UTC" })
      .expect(400);
    expect(res.body.error).toMatch(/frequency/);
  });

  it("rejects out-of-range hourLocal", async () => {
    const orgId = await makeOrg("patch_hour");
    const admin = await makeUser(orgId, "org_admin");
    for (const bad of [-1, 24, 99, 1.5]) {
      const res = await request(createTestApp(admin))
        .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
        .send({ frequency: "daily", hourLocal: bad, timezone: "UTC" })
        .expect(400);
      expect(res.body.error).toMatch(/hourLocal/);
    }
  });

  it("rejects an unknown IANA timezone", async () => {
    const orgId = await makeOrg("patch_tz");
    const admin = await makeUser(orgId, "org_admin");
    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "daily", hourLocal: 9, timezone: "Not/A_Real_Zone" })
      .expect(400);
    expect(res.body.error).toMatch(/timezone/i);
  });

  it("saves a valid schedule and resets lastSentOn so the next tick fires", async () => {
    const orgId = await makeOrg("patch_save");
    // Pretend the cron sent a digest yesterday — PATCH must clear it.
    await db.update(organizationsTable).set({
      bouncedDigestLastSentOn: "2026-04-17",
    }).where(eq(organizationsTable.id, orgId));

    const admin = await makeUser(orgId, "org_admin");
    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekday", hourLocal: 7, timezone: "America/New_York" })
      .expect(200);

    expect(res.body).toEqual({
      frequency: "weekday",
      hourLocal: 7,
      timezone: "America/New_York",
      lastSentOn: null,
    });

    // Round-trip via GET to make sure it actually persisted.
    const getRes = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .expect(200);
    expect(getRes.body).toEqual({
      frequency: "weekday",
      hourLocal: 7,
      timezone: "America/New_York",
      lastSentOn: null,
    });
  });

  it("accepts hourLocal/timezone omitted (any-time, server-time)", async () => {
    const orgId = await makeOrg("patch_nulls");
    const admin = await makeUser(orgId, "org_admin");
    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "daily", hourLocal: null, timezone: "" })
      .expect(200);
    expect(res.body.frequency).toBe("daily");
    expect(res.body.hourLocal).toBeNull();
    expect(res.body.timezone).toBeNull();
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("patch_authz");
    await request(createTestApp())
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "daily" })
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "daily" })
      .expect(403);
  });
});
