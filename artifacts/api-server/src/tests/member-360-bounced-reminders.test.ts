/**
 * Integration tests for the per-member bounced-reminders banner that powers
 * the "Levy reminder failed" badge on the Member 360 page (Task #243, #276).
 *
 * The test exercises the API contract that the badge depends on, end to end:
 *   GET /api/organizations/:orgId/members-360/levies/bounced-reminders?memberId=<id>
 *
 * Coverage:
 *   1. Bounced member -> response payload has the seeded levy with
 *      unresolvedFailedCount=1, totalBounced=1, the channel breakdown the
 *      banner renders, and the levy id required to build the deep link
 *      /club-members?openLevy=<levyId>&highlightMember=<memberId>.
 *   2. Clean member -> empty payload (totalBounced=0, levies=[]) so the
 *      banner does NOT render.
 *   3. Member-level scoping -> a failed reminder belonging to a *different*
 *      member in the same org does NOT leak into the queried member's badge
 *      (Task #243 isolation guarantee).
 *   4. Supersession -> if a more recent send for the same (member, channel,
 *      levy) succeeded, the older failure is excluded so the badge clears
 *      itself once the reminder is resent successfully.
 *   5. Auth -> non-admin and unauthenticated callers cannot read the
 *      endpoint (the banner only renders for member-admin users).
 *
 * The follow-up UI behaviour ("clicking the badge opens /club-members with
 * the dialog and highlighted row, the highlight clears after ~6s") was
 * verified out-of-band against this same data shape during the task that
 * introduced this file (see commit message). Playwright is not yet wired
 * into this repo as a committable harness; once it is, a minimal UI path
 * test should be added alongside this contract test.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberMessagesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdLevyIds: number[] = [];

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `BouncedReminders_${tag}`,
    slug: `bounced-reminders-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeAdmin(orgId: number): Promise<TestUser> {
  const tag = uid("admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: "Admin", role: "org_admin", organizationId: orgId };
}

async function makePlayer(orgId: number): Promise<TestUser> {
  const tag = uid("player");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: "Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: "Player", role: "player", organizationId: orgId };
}

async function makeMember(orgId: number, firstName: string): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName,
    lastName: "Tester",
    email: `${uid("m")}@test.local`,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function makeLevy(orgId: number, name: string): Promise<number> {
  const [l] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  createdLevyIds.push(l.id);
  return l.id;
}

async function chargeMembers(levyId: number, memberIds: number[]) {
  await db.insert(memberLevyChargesTable).values(
    memberIds.map((mid) => ({ levyId, clubMemberId: mid, amount: "100.00" })),
  );
}

async function insertMessage(opts: {
  orgId: number; memberId: number; levyId: number;
  channel: "email" | "sms" | "whatsapp" | "push" | "in_app";
  status: "sent" | "failed";
  sentAt: Date;
  errorMessage?: string | null;
}) {
  await db.insert(memberMessagesTable).values({
    organizationId: opts.orgId,
    clubMemberId: opts.memberId,
    channel: opts.channel,
    body: "Levy reminder",
    status: opts.status,
    sentAt: opts.sentAt,
    errorMessage: opts.errorMessage ?? null,
    relatedEntity: "levy",
    relatedEntityId: opts.levyId,
  });
}

afterAll(async () => {
  if (createdLevyIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.relatedEntityId, createdLevyIds));
    await db.delete(memberLevyChargesTable).where(inArray(memberLevyChargesTable.levyId, createdLevyIds));
    await db.delete(memberLeviesTable).where(inArray(memberLeviesTable.id, createdLevyIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /members-360/levies/bounced-reminders?memberId=<id> — Member 360 badge contract", () => {
  it("bounced member: returns the seeded levy with the badge count and deep-link payload", async () => {
    const orgId = await makeOrg("badge");
    const admin = await makeAdmin(orgId);
    const bounced = await makeMember(orgId, "Bouncy");
    const clean = await makeMember(orgId, "Clean");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [bounced, clean]);
    await insertMessage({
      orgId, memberId: bounced, levyId,
      channel: "email", status: "failed",
      sentAt: new Date("2025-04-01T10:00:00Z"),
      errorMessage: "SMTP 550 mailbox unavailable",
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(bounced) })
      .expect(200);

    expect(res.body.totalBounced).toBe(1);
    expect(res.body.levies).toHaveLength(1);
    const [entry] = res.body.levies;
    expect(entry.levyId).toBe(levyId);
    expect(entry.name).toBe("Annual Levy");
    expect(entry.unresolvedFailedCount).toBe(1);
    expect(entry.channels).toEqual({ email: 1 });
    expect(entry.sampleError).toContain("SMTP 550");
    expect(entry.latestFailureAt).toBe("2025-04-01T10:00:00.000Z");

    // The badge builds /club-members?openLevy=<levyId>&highlightMember=<memberId>
    // — make sure the ids the client needs are present so the deep link is buildable.
    expect(typeof entry.levyId).toBe("number");
  });

  it("clean member: returns empty payload so the banner does not render", async () => {
    const orgId = await makeOrg("clean");
    const admin = await makeAdmin(orgId);
    const bounced = await makeMember(orgId, "Bouncy");
    const clean = await makeMember(orgId, "Clean");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [bounced, clean]);
    await insertMessage({
      orgId, memberId: bounced, levyId,
      channel: "email", status: "failed",
      sentAt: new Date("2025-04-01T10:00:00Z"),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(clean) })
      .expect(200);

    expect(res.body.totalBounced).toBe(0);
    expect(res.body.levies).toEqual([]);
  });

  it("member scoping: another member's bounce does not leak into the queried member's badge", async () => {
    const orgId = await makeOrg("scope");
    const admin = await makeAdmin(orgId);
    const target = await makeMember(orgId, "Target");
    const other = await makeMember(orgId, "Other");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [target, other]);
    // Bounce belongs to "other", not "target"
    await insertMessage({
      orgId, memberId: other, levyId,
      channel: "email", status: "failed",
      sentAt: new Date("2025-04-01T10:00:00Z"),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(target) })
      .expect(200);

    expect(res.body.totalBounced).toBe(0);
    expect(res.body.levies).toEqual([]);
  });

  it("supersession: a later successful send for the same (member, channel, levy) clears the badge", async () => {
    const orgId = await makeOrg("supersede");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId, "Recovered");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [member]);
    await insertMessage({
      orgId, memberId: member, levyId,
      channel: "email", status: "failed",
      sentAt: new Date("2025-04-01T10:00:00Z"),
    });
    await insertMessage({
      orgId, memberId: member, levyId,
      channel: "email", status: "sent",
      sentAt: new Date("2025-04-02T10:00:00Z"),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(member) })
      .expect(200);

    expect(res.body.totalBounced).toBe(0);
    expect(res.body.levies).toEqual([]);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("authz");
    const member = await makeMember(orgId, "Ghost");

    // Unauthenticated
    const anon = createTestApp();
    await request(anon)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(member) })
      .expect(401);

    // Player role -> 403
    const player = await makePlayer(orgId);
    const playerApp = createTestApp(player);
    await request(playerApp)
      .get(`/api/organizations/${orgId}/members-360/levies/bounced-reminders`)
      .query({ memberId: String(member) })
      .expect(403);
  });
});
