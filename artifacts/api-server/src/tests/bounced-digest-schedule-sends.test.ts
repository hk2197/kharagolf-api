/**
 * Task #513 — audit trail of schedule-change emails dispatched to admins.
 *
 * Coverage:
 *   - PATCH /api/organizations/:orgId/bounced-digest-prefs records a row
 *     in bounced_digest_schedule_sends with the recipients who actually
 *     received the heads-up email.
 *   - The throttled re-save (within 60s) does NOT add a second audit row.
 *   - GET /api/organizations/:orgId/bounced-digest-schedule-sends returns
 *     the latest send first, with recipients + changedBy populated, and
 *     enforces the same RBAC as the schedule editor.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  bouncedDigestScheduleSendsTable,
  bouncedDigestScheduleOptOutsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { inArray, eq } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import { _resetBouncedDigestNotifyThrottleForTests } from "../routes/organizations.js";

// Stub the mailer so the test does not actually try to dispatch SMTP.
vi.mock("../lib/mailer.js", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    sendBouncedDigestScheduleChangedEmail: vi.fn(async () => undefined),
    sendBouncedLevyDigestEmail: vi.fn(async () => undefined),
  };
});

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-sends";
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `Sends_${tag}`,
    slug: `sends-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number | null, role: OrgRole): Promise<TestUser> {
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
    organizationId: role === "org_admin" ? (orgId ?? undefined) : undefined,
  };
}

afterAll(async () => {
  if (createdOrgIds.length) {
    await db.delete(bouncedDigestScheduleSendsTable)
      .where(inArray(bouncedDigestScheduleSendsTable.organizationId, createdOrgIds));
    await db.delete(bouncedDigestScheduleOptOutsTable)
      .where(inArray(bouncedDigestScheduleOptOutsTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("schedule-change email audit trail", () => {
  it("records an audit row with recipients when the schedule actually changes", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("audit_basic");
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekly", hourLocal: 9, timezone: "Asia/Kolkata" })
      .expect(200);
    expect(res.body.frequency).toBe("weekly");

    // The notify is fire-and-forget (`void notify…`), so wait briefly for
    // the insert to land before asserting.
    await new Promise(r => setTimeout(r, 250));

    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].changedByUserId).toBe(admin.id);
    expect(rows[0].recipients).toEqual([
      expect.objectContaining({ userId: admin.id, email: expect.stringContaining("@test.local") }),
    ]);
  });

  it("does not double-count when an admin re-saves within the throttle window", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("audit_throttle");
    const admin = await makeUser(orgId, "org_admin");

    // First save: daily → weekly should send.
    await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekly", hourLocal: 9, timezone: "Asia/Kolkata" })
      .expect(200);
    await new Promise(r => setTimeout(r, 200));

    // Second save almost immediately, with a different hour so the schedule
    // really changes again — the per-org throttle must suppress the second
    // notify and therefore the second audit row.
    await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekly", hourLocal: 10, timezone: "Asia/Kolkata" })
      .expect(200);
    await new Promise(r => setTimeout(r, 200));

    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("survives an API server restart — DB-backed throttle still suppresses the second send", async () => {
    // Task #654 — simulate a restart by writing the throttle timestamp
    // straight into the org row (as the previous server instance would
    // have). With the in-memory Map gone, the new instance must read
    // this column and refuse to send a second heads-up within 60s.
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("audit_restart");
    const admin = await makeUser(orgId, "org_admin");

    await db.update(organizationsTable)
      .set({ bouncedDigestScheduleNotifyAt: new Date() })
      .where(eq(organizationsTable.id, orgId));

    await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekly", hourLocal: 9, timezone: "Asia/Kolkata" })
      .expect(200);
    await new Promise(r => setTimeout(r, 250));

    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(0);
  });

  it("excludes opted-out recipients from the audit row", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("audit_optout");
    const admin = await makeUser(orgId, "org_admin");
    const otherAdmin = await makeUser(orgId, "org_admin");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgId,
      userId: otherAdmin.id,
    });

    await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/bounced-digest-prefs`)
      .send({ frequency: "weekly", hourLocal: 9, timezone: "Asia/Kolkata" })
      .expect(200);
    await new Promise(r => setTimeout(r, 250));

    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
    const recipients = rows[0].recipients as Array<{ userId: number }>;
    const recipientIds = recipients.map(r => r.userId);
    expect(recipientIds).toContain(admin.id);
    expect(recipientIds).not.toContain(otherAdmin.id);
  });
});

describe("GET /api/organizations/:orgId/bounced-digest-schedule-sends", () => {
  it("returns the latest sends with changedBy + recipients populated", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("list_sends");
    const admin = await makeUser(orgId, "org_admin");

    // Seed two sends so we can assert ordering (newest first).
    await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      sentAt: new Date(Date.now() - 60_000),
      recipients: [{ userId: admin.id, email: "older@test.local", displayName: "Older" }],
    });
    await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      recipients: [{ userId: admin.id, email: "newer@test.local", displayName: "Newer" }],
    });

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-sends`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].recipients[0].email).toBe("newer@test.local");
    expect(res.body[1].recipients[0].email).toBe("older@test.local");
    expect(res.body[0].changedBy).toMatchObject({ userId: admin.id });
    expect(typeof res.body[0].sentAt).toBe("string");
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("list_sends_authz");
    await request(createTestApp())
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-sends`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-sends`)
      .expect(403);
  });
});

describe("POST /api/organizations/:orgId/bounced-digest-schedule-sends/:sendId/resend — Task #655", () => {
  it("resends to the original recipient list and writes a new audit row without altering schedule prefs", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("resend_basic");
    const admin = await makeUser(orgId, "org_admin");

    // Pin a known schedule, then read it back so we can assert no drift.
    await db.update(organizationsTable)
      .set({
        bouncedDigestFrequency: "weekly",
        bouncedDigestHourLocal: 9,
        bouncedDigestTimezone: "Asia/Kolkata",
        bouncedDigestLastSentOn: "2026-04-01",
      })
      .where(eq(organizationsTable.id, orgId));
    const [before] = await db.select({
      frequency: organizationsTable.bouncedDigestFrequency,
      hourLocal: organizationsTable.bouncedDigestHourLocal,
      timezone: organizationsTable.bouncedDigestTimezone,
      lastSentOn: organizationsTable.bouncedDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

    // Seed one historical send.
    const [seed] = await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      recipients: [
        { userId: admin.id, email: `${admin.username}@test.local`, displayName: "Original Admin" },
      ],
    }).returning({ id: bouncedDigestScheduleSendsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(201);
    expect(res.body.id).toBeGreaterThan(seed.id);
    expect(res.body.recipients).toEqual([
      expect.objectContaining({ userId: admin.id, email: `${admin.username}@test.local` }),
    ]);
    expect(res.body.changedBy).toMatchObject({ userId: admin.id });

    // Audit table now has both rows.
    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(2);

    // Schedule prefs are untouched.
    const [after] = await db.select({
      frequency: organizationsTable.bouncedDigestFrequency,
      hourLocal: organizationsTable.bouncedDigestHourLocal,
      timezone: organizationsTable.bouncedDigestTimezone,
      lastSentOn: organizationsTable.bouncedDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(after).toEqual(before);
  });

  it("rejects a second resend of the same send within the cooldown with 429", async () => {
    // Task #813 — per-(org, sendId) cooldown so rapid Resend clicks don't
    // dispatch repeat emails. The first call succeeds; the second call
    // landing inside the 60s window must be rejected with 429.
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("resend_cooldown");
    const admin = await makeUser(orgId, "org_admin");
    const [seed] = await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      recipients: [
        { userId: admin.id, email: `${admin.username}@test.local`, displayName: "Admin" },
      ],
    }).returning({ id: bouncedDigestScheduleSendsTable.id });

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(201);

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(429);
    expect(res.body.error).toMatch(/wait/i);
    // Task #947 — the 429 must surface a precise per-row countdown so the
    // UI can disable the Resend button and show "Resend in Ns" instead of
    // bouncing the admin off a generic toast. Both the JSON `retryAfterSeconds`
    // and the standard `Retry-After` header are required.
    expect(typeof res.body.retryAfterSeconds).toBe("number");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(res.body.cooldownSeconds).toBe(60);
    expect(typeof res.body.lastResendAt).toBe("string");
    expect(res.headers["retry-after"]).toBe(String(res.body.retryAfterSeconds));

    // Audit table should only contain the original seed row + the one
    // successful resend audit row (the throttled second click did NOT
    // insert a third row).
    const rows = await db.select()
      .from(bouncedDigestScheduleSendsTable)
      .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId));
    expect(rows).toHaveLength(2);
  });

  it("returns lastResendAt + cooldown metadata on the listing endpoint", async () => {
    // Task #947 — admins reloading the Club Settings page must see the
    // remaining cooldown re-derived from the latest send's lastResendAt.
    _resetBouncedDigestNotifyThrottleForTests();
    const orgId = await makeOrg("resend_listing_meta");
    const admin = await makeUser(orgId, "org_admin");
    const [seed] = await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      recipients: [{ userId: admin.id, email: `${admin.username}@test.local`, displayName: "Admin" }],
    }).returning({ id: bouncedDigestScheduleSendsTable.id });

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(201);

    const list = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-sends`)
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    const seedRow = list.body.find((r: { id: number }) => r.id === seed.id);
    expect(seedRow).toBeTruthy();
    expect(typeof seedRow.lastResendAt).toBe("string");
    expect(seedRow.resendCooldownSeconds).toBe(60);
  });

  it("returns 404 for a send id that does not belong to the org", async () => {
    _resetBouncedDigestNotifyThrottleForTests();
    const orgA = await makeOrg("resend_404_a");
    const orgB = await makeOrg("resend_404_b");
    const adminB = await makeUser(orgB, "org_admin");
    const [seed] = await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgA,
      changedByUserId: adminB.id,
      recipients: [{ userId: adminB.id, email: "x@test.local", displayName: "X" }],
    }).returning({ id: bouncedDigestScheduleSendsTable.id });

    await request(createTestApp(adminB))
      .post(`/api/organizations/${orgB}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(404);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("resend_authz");
    const admin = await makeUser(orgId, "org_admin");
    const [seed] = await db.insert(bouncedDigestScheduleSendsTable).values({
      organizationId: orgId,
      changedByUserId: admin.id,
      recipients: [{ userId: admin.id, email: "y@test.local", displayName: "Y" }],
    }).returning({ id: bouncedDigestScheduleSendsTable.id });

    await request(createTestApp())
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .post(`/api/organizations/${orgId}/bounced-digest-schedule-sends/${seed.id}/resend`)
      .expect(403);
  });
});
