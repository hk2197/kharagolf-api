/**
 * Task #647 — signed-in members can manage their per-org email opt-outs
 * directly from profile settings (no token link, no admin help required).
 *
 * Coverage:
 *   - GET /api/portal/email-subscriptions returns the catalog of email types
 *     and a row per (org, email-type) the caller is *eligible* to receive,
 *     each tagged with its current `optedOut` state.
 *   - POST /api/portal/email-subscriptions/unsubscribe records an opt-out and
 *     is idempotent.
 *   - POST /api/portal/email-subscriptions/resubscribe clears the opt-out and
 *     is idempotent (works even when no row exists).
 *   - A member can flip a row OFF→ON→OFF entirely from these endpoints.
 *   - All endpoints require authentication.
 *   - Bad inputs (unknown emailType, non-existent org, invalid orgId) are
 *     rejected without writing.
 *   - One member's opt-outs are isolated from another member's.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  bouncedDigestScheduleOptOutsTable,
} from "@workspace/db";
import { inArray, eq, and } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-email-prefs";
});

async function makeOrg(label: string): Promise<{ id: number; name: string }> {
  const tag = uid(label);
  const name = `EmailPrefs_${tag}`;
  const [o] = await db.insert(organizationsTable).values({
    name,
    slug: `emailprefs-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return { id: o.id, name };
}

async function makeUser(label: string): Promise<TestUser> {
  const tag = uid(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: label,
    role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: label, role: "player" };
}

async function joinOrg(userId: number, orgId: number) {
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "player",
  }).onConflictDoNothing();
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(bouncedDigestScheduleOptOutsTable).where(inArray(bouncedDigestScheduleOptOutsTable.userId, createdUserIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /api/portal/email-subscriptions", () => {
  it("requires authentication", async () => {
    await request(createTestApp())
      .get("/api/portal/email-subscriptions")
      .expect(401);
  });

  it("returns one row per (eligible org × email type), with current opted-out state", async () => {
    const orgA = await makeOrg("orgA_eligible");
    const orgB = await makeOrg("orgB_eligible");
    const me = await makeUser("matrix_me");
    await joinOrg(me.id, orgA.id);
    await joinOrg(me.id, orgB.id);

    // Pre-seed an opt-out for orgA only.
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: orgA.id, userId: me.id,
    });

    const res = await request(createTestApp(me))
      .get("/api/portal/email-subscriptions")
      .expect(200);

    expect(Array.isArray(res.body.types)).toBe(true);
    expect(res.body.types.some((t: { key: string }) => t.key === "bounced_digest_schedule")).toBe(true);

    expect(Array.isArray(res.body.subscriptions)).toBe(true);
    const mine = res.body.subscriptions.filter((r: { orgId: number }) =>
      r.orgId === orgA.id || r.orgId === orgB.id);
    // 2 orgs × 1 type currently registered = 2 rows.
    expect(mine).toHaveLength(2);

    const orgARow = mine.find((r: { orgId: number }) => r.orgId === orgA.id);
    const orgBRow = mine.find((r: { orgId: number }) => r.orgId === orgB.id);
    expect(orgARow).toMatchObject({
      orgId: orgA.id, orgName: orgA.name,
      emailType: "bounced_digest_schedule", optedOut: true,
    });
    expect(typeof orgARow.optedOutAt).toBe("string");
    expect(orgBRow).toMatchObject({
      orgId: orgB.id, orgName: orgB.name,
      emailType: "bounced_digest_schedule", optedOut: false,
      optedOutAt: null,
    });
  });

  it("isolates one member's opt-outs from another member's", async () => {
    const org = await makeOrg("isolation");
    const me = await makeUser("iso_me");
    const other = await makeUser("iso_other");
    await joinOrg(me.id, org.id);
    await joinOrg(other.id, org.id);
    // Other user is opted out — must not affect my row.
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id, userId: other.id,
    });

    const res = await request(createTestApp(me))
      .get("/api/portal/email-subscriptions")
      .expect(200);

    const myRow = res.body.subscriptions.find((r: { orgId: number; emailType: string }) =>
      r.orgId === org.id && r.emailType === "bounced_digest_schedule");
    expect(myRow).toBeDefined();
    expect(myRow.optedOut).toBe(false);
  });

  it("includes orgs the user has an opt-out for even with no membership row", async () => {
    // Edge case: user used to be in an org, was removed, but the opt-out row
    // they created persists. We still need to surface it so they can re-subscribe.
    const org = await makeOrg("lapsed_member");
    const me = await makeUser("lapsed_me");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id, userId: me.id,
    });
    // Note: no joinOrg() call — user has no current membership.

    const res = await request(createTestApp(me))
      .get("/api/portal/email-subscriptions")
      .expect(200);
    const row = res.body.subscriptions.find((r: { orgId: number }) => r.orgId === org.id);
    expect(row).toBeDefined();
    expect(row.optedOut).toBe(true);
  });

  it("returns an empty subscriptions list for a member in no orgs", async () => {
    const me = await makeUser("no_orgs");
    const res = await request(createTestApp(me))
      .get("/api/portal/email-subscriptions")
      .expect(200);
    expect(res.body.subscriptions).toEqual([]);
  });
});

describe("POST /api/portal/email-subscriptions/unsubscribe", () => {
  it("requires authentication", async () => {
    await request(createTestApp())
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: 1, emailType: "bounced_digest_schedule" })
      .expect(401);
  });

  it("records an opt-out and is idempotent", async () => {
    const org = await makeOrg("unsub");
    const me = await makeUser("unsub_user");

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    const rows = await db.select().from(bouncedDigestScheduleOptOutsTable).where(and(
      eq(bouncedDigestScheduleOptOutsTable.organizationId, org.id),
      eq(bouncedDigestScheduleOptOutsTable.userId, me.id),
    ));
    expect(rows).toHaveLength(1);

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    const after = await db.select().from(bouncedDigestScheduleOptOutsTable).where(and(
      eq(bouncedDigestScheduleOptOutsTable.organizationId, org.id),
      eq(bouncedDigestScheduleOptOutsTable.userId, me.id),
    ));
    expect(after).toHaveLength(1);
  });

  it("rejects unknown emailType and missing orgId without writing", async () => {
    const org = await makeOrg("badreq");
    const me = await makeUser("badreq_user");

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: org.id, emailType: "definitely-not-a-real-type" })
      .expect(400);

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ emailType: "bounced_digest_schedule" })
      .expect(400);

    const rows = await db.select().from(bouncedDigestScheduleOptOutsTable)
      .where(eq(bouncedDigestScheduleOptOutsTable.userId, me.id));
    expect(rows).toHaveLength(0);
  });

  it("400s when the org does not exist (FK violation, no row written)", async () => {
    const me = await makeUser("ghost_org");
    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: 2_147_000_000, emailType: "bounced_digest_schedule" })
      .expect(400);
    const rows = await db.select().from(bouncedDigestScheduleOptOutsTable)
      .where(eq(bouncedDigestScheduleOptOutsTable.userId, me.id));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/portal/email-subscriptions/resubscribe", () => {
  it("requires authentication", async () => {
    await request(createTestApp())
      .post("/api/portal/email-subscriptions/resubscribe")
      .send({ orgId: 1, emailType: "bounced_digest_schedule" })
      .expect(401);
  });

  it("clears the opt-out and is idempotent (works without a row)", async () => {
    const org = await makeOrg("resub");
    const me = await makeUser("resub_user");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id, userId: me.id,
    });

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/resubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    const rows = await db.select().from(bouncedDigestScheduleOptOutsTable).where(and(
      eq(bouncedDigestScheduleOptOutsTable.organizationId, org.id),
      eq(bouncedDigestScheduleOptOutsTable.userId, me.id),
    ));
    expect(rows).toHaveLength(0);

    await request(createTestApp(me))
      .post("/api/portal/email-subscriptions/resubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);
  });

  it("a member can only re-subscribe themselves, not another user", async () => {
    const org = await makeOrg("resub_isolation");
    const victim = await makeUser("victim");
    const attacker = await makeUser("attacker");
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id, userId: victim.id,
    });

    await request(createTestApp(attacker))
      .post("/api/portal/email-subscriptions/resubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    const rows = await db.select().from(bouncedDigestScheduleOptOutsTable).where(and(
      eq(bouncedDigestScheduleOptOutsTable.organizationId, org.id),
      eq(bouncedDigestScheduleOptOutsTable.userId, victim.id),
    ));
    expect(rows).toHaveLength(1);
  });
});

describe("Task #647 end-to-end: profile-settings toggle OFF→ON→OFF", () => {
  it("a member can fully toggle a subscription from profile endpoints alone", async () => {
    const org = await makeOrg("e2e_toggle");
    const me = await makeUser("e2e_toggle_user");
    await joinOrg(me.id, org.id);
    const app = () => createTestApp(me);

    // Initial state: subscribed.
    let res = await request(app()).get("/api/portal/email-subscriptions").expect(200);
    let row = res.body.subscriptions.find((r: { orgId: number }) => r.orgId === org.id);
    expect(row.optedOut).toBe(false);

    // Toggle OFF (unsubscribe).
    await request(app())
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    res = await request(app()).get("/api/portal/email-subscriptions").expect(200);
    row = res.body.subscriptions.find((r: { orgId: number }) => r.orgId === org.id);
    expect(row.optedOut).toBe(true);
    expect(row.optedOutAt).not.toBeNull();

    // Toggle ON (resubscribe).
    await request(app())
      .post("/api/portal/email-subscriptions/resubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    res = await request(app()).get("/api/portal/email-subscriptions").expect(200);
    row = res.body.subscriptions.find((r: { orgId: number }) => r.orgId === org.id);
    expect(row.optedOut).toBe(false);
    expect(row.optedOutAt).toBeNull();

    // Toggle OFF again — proves no token-link is needed for the second cycle either.
    await request(app())
      .post("/api/portal/email-subscriptions/unsubscribe")
      .send({ orgId: org.id, emailType: "bounced_digest_schedule" })
      .expect(204);

    res = await request(app()).get("/api/portal/email-subscriptions").expect(200);
    row = res.body.subscriptions.find((r: { orgId: number }) => r.orgId === org.id);
    expect(row.optedOut).toBe(true);
  });
});
