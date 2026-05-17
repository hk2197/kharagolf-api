/**
 * Task #387 — recipients can opt out of just the schedule-change heads-up
 * emails (the regular bounced-levy digest still arrives).
 *
 * Coverage:
 *   - The HMAC-signed unsubscribe token round-trips and rejects tampering.
 *   - GET /api/public/bounced-digest-schedule-unsubscribe records an opt-out
 *     row, is idempotent, and rejects bad / tampered tokens.
 *   - GET /api/organizations/:orgId/bounced-digest-schedule-opt-outs lists
 *     opted-out recipients for org admins and is gated by the same RBAC as
 *     the digest schedule editor.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  bouncedDigestScheduleOptOutsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { inArray, eq, and } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import {
  signBouncedDigestScheduleOptOutToken,
  verifyBouncedDigestScheduleOptOutToken,
} from "../lib/bouncedDigestUnsubscribe.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-opt-out-tokens";
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `OptOut_${tag}`,
    slug: `optout-${tag}`.toLowerCase(),
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
  if (createdUserIds.length) {
    await db.delete(bouncedDigestScheduleOptOutsTable).where(inArray(bouncedDigestScheduleOptOutsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("bounced-digest schedule-change opt-out token", () => {
  it("round-trips a signed (userId, orgId) token", () => {
    const t = signBouncedDigestScheduleOptOutToken(42, 7);
    expect(verifyBouncedDigestScheduleOptOutToken(t)).toEqual({ userId: 42, orgId: 7 });
  });

  it("rejects tampered, malformed, and empty tokens", () => {
    expect(verifyBouncedDigestScheduleOptOutToken("")).toBeNull();
    expect(verifyBouncedDigestScheduleOptOutToken("not-a-token")).toBeNull();
    const t = signBouncedDigestScheduleOptOutToken(1, 2);
    // Mutate one character of the underlying base64url payload.
    const flipped = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyBouncedDigestScheduleOptOutToken(flipped)).toBeNull();
  });
});

describe("GET /api/public/bounced-digest-schedule-unsubscribe", () => {
  it("records an opt-out row for a valid token and is idempotent", async () => {
    const orgId = await makeOrg("public_unsub");
    const user = await makeUser(orgId, "org_admin");
    const token = signBouncedDigestScheduleOptOutToken(user.id, orgId);

    const res = await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/unsubscribed/i);

    const rows = await db
      .select()
      .from(bouncedDigestScheduleOptOutsTable)
      .where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, user.id),
      ));
    expect(rows).toHaveLength(1);

    // Clicking again must not 500 nor duplicate the row.
    await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    const rowsAfter = await db
      .select()
      .from(bouncedDigestScheduleOptOutsTable)
      .where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, user.id),
      ));
    expect(rowsAfter).toHaveLength(1);
  });

  it("rejects an invalid token without writing anything", async () => {
    const res = await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-unsubscribe?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid/i);
  });
});

describe("GET /api/public/bounced-digest-schedule-resubscribe (Task #512)", () => {
  it("clears the opt-out for a valid token and is idempotent", async () => {
    const orgId = await makeOrg("public_resub");
    const user = await makeUser(orgId, "org_admin");
    // Pre-seed an opt-out the way Task #387's flow would have.
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgId,
      userId: user.id,
    });
    const token = signBouncedDigestScheduleOptOutToken(user.id, orgId);

    const res = await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/re-subscribed/i);

    const rows = await db
      .select()
      .from(bouncedDigestScheduleOptOutsTable)
      .where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, user.id),
      ));
    expect(rows).toHaveLength(0);

    // Clicking again with no row present must still succeed.
    await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
  });

  it("rejects an invalid token", async () => {
    const res = await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-resubscribe?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid/i);
  });

  it("the unsubscribe confirmation page links to the re-subscribe URL", async () => {
    const orgId = await makeOrg("unsub_links_resub");
    const user = await makeUser(orgId, "org_admin");
    const token = signBouncedDigestScheduleOptOutToken(user.id, orgId);

    const res = await request(createTestApp())
      .get(`/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toContain(`/api/public/bounced-digest-schedule-resubscribe?token=${encodeURIComponent(token)}`);
    expect(res.text).toMatch(/re-subscribe/i);
  });
});

describe("DELETE /api/organizations/:orgId/bounced-digest-schedule-opt-outs/:userId (Task #512)", () => {
  it("lets an org_admin re-subscribe a member and is idempotent", async () => {
    const orgId = await makeOrg("admin_resub");
    const admin = await makeUser(orgId, "org_admin");
    const member = await makeUser(orgId, "player");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgId,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    const rows = await db
      .select()
      .from(bouncedDigestScheduleOptOutsTable)
      .where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, member.id),
      ));
    expect(rows).toHaveLength(0);

    // Idempotent — deleting again is still 204.
    await request(createTestApp(admin))
      .delete(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("admin_resub_authz");
    const member = await makeUser(orgId, "player");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgId,
      userId: member.id,
    });

    await request(createTestApp())
      .delete(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .delete(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(403);

    // Row must still be present after the failed attempts.
    const rows = await db
      .select()
      .from(bouncedDigestScheduleOptOutsTable)
      .where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, member.id),
      ));
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/organizations/:orgId/bounced-digest-schedule-opt-outs", () => {
  it("lists opted-out recipients for an org_admin caller", async () => {
    const orgId = await makeOrg("list_admin");
    const admin = await makeUser(orgId, "org_admin");
    const treasurer = await makeUser(orgId, "player"); // membership role doesn't matter for the table
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgId,
      userId: treasurer.id,
    });

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      userId: treasurer.id,
      email: expect.stringContaining("@test.local"),
    });
    expect(typeof res.body[0].optedOutAt).toBe("string");
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("list_authz");
    await request(createTestApp())
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/bounced-digest-schedule-opt-outs`)
      .expect(403);
  });
});
