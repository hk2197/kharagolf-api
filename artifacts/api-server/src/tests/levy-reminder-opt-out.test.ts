/**
 * Integration tests: per-channel opt-out for levy reminders (Task #343 coverage)
 *
 * Task #343 added member_comm_prefs (`billing` category) per-channel opt-in
 * checks to:
 *   POST /api/organizations/:orgId/members-360/levies/:id/remind
 *   POST /api/organizations/:orgId/members-360/levies/:id/retry-failed
 *
 * Before Task #343 a member who had disabled WhatsApp (or SMS / email / in-app)
 * for the `billing` category would still be pinged by levy reminders. Now the
 * route inserts a member_messages row with status='skipped' for opted-out
 * members and reports them under `skippedCount` instead of `sentCount` /
 * `failedCount`.
 *
 * Coverage:
 *   1. /remind with channel='whatsapp' — one opted-in member (sent), one
 *      opted-out member (skipped). sendBroadcast is called exactly once
 *      (only for the opted-in member) and a member_messages row with
 *      status='skipped' is written for the opted-out member.
 *   2. /retry-failed — seed two prior failed WhatsApp reminders, set the
 *      `billing.whatsapp_enabled=false` opt-out for one of the two, then
 *      retry. Expect retriedCount=2, sentCount=1, skippedCount=1, and a
 *      fresh skipped row for the opted-out member.
 *   3. Schema-default — a member with NO member_comm_prefs row is treated
 *      as opted-out for sms/whatsapp (the schema default for those two
 *      channels is `false`). Verified for both /remind and /retry-failed.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/comms.js", async () => ({
  sendBroadcast: vi.fn(async (_recipients: unknown, opts: { channels: string[] }) => {
    const stats: Record<string, { sent: number; failed: number }> = {};
    for (const ch of opts.channels) stats[ch] = { sent: 1, failed: 0 };
    return stats;
  }),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberMessagesTable,
  memberCommPrefsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendBroadcast } from "../lib/comms.js";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const broadcastMock = vi.mocked(sendBroadcast);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdLevyIds: number[] = [];

beforeEach(() => {
  broadcastMock.mockClear();
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `LevyOptOut_${tag}`,
    slug: `levy-opt-out-${tag}`.toLowerCase(),
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

async function makeMember(orgId: number, firstName: string): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName,
    lastName: "Tester",
    email: `${uid("m")}@test.local`,
    phone: "+9112345" + Math.floor(Math.random() * 100000).toString().padStart(5, "0"),
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
    memberIds.map((mid) => ({
      levyId,
      clubMemberId: mid,
      amount: "100.00",
      status: "unpaid" as const,
    })),
  );
}

async function setBillingPref(orgId: number, memberId: number, channel: "email" | "sms" | "whatsapp" | "in_app", enabled: boolean) {
  await db.insert(memberCommPrefsTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    category: "billing",
    // Schema defaults: email=true, sms=false, push=true, whatsapp=false, in_app=true.
    // Override only the channel under test so the seed reflects the real opt-out shape.
    emailEnabled: channel === "email" ? enabled : true,
    smsEnabled: channel === "sms" ? enabled : false,
    whatsappEnabled: channel === "whatsapp" ? enabled : false,
    inAppEnabled: channel === "in_app" ? enabled : true,
  });
}

async function insertPriorFailedWhatsApp(orgId: number, memberId: number, levyId: number) {
  await db.insert(memberMessagesTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    channel: "whatsapp",
    subject: "Reminder: Annual Levy outstanding",
    body: "Levy reminder",
    status: "failed",
    sentAt: new Date("2025-04-01T10:00:00Z"),
    errorMessage: "whatsapp delivery failed",
    relatedEntity: "levy",
    relatedEntityId: levyId,
  });
}

afterAll(async () => {
  if (createdLevyIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.relatedEntityId, createdLevyIds));
    await db.delete(memberLevyChargesTable).where(inArray(memberLevyChargesTable.levyId, createdLevyIds));
    await db.delete(memberLeviesTable).where(inArray(memberLeviesTable.id, createdLevyIds));
  }
  if (createdMemberIds.length) {
    await db.delete(memberCommPrefsTable).where(inArray(memberCommPrefsTable.clubMemberId, createdMemberIds));
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.clubMemberId, createdMemberIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.actorUserId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("POST /levies/:id/remind — per-channel opt-out (Task #343)", () => {
  it("whatsapp: opted-out member is skipped; sentCount=1, skippedCount=1, status='skipped' row written", async () => {
    const orgId = await makeOrg("remind");
    const admin = await makeAdmin(orgId);
    const optedIn = await makeMember(orgId, "OptedIn");
    const optedOut = await makeMember(orgId, "OptedOut");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [optedIn, optedOut]);
    await setBillingPref(orgId, optedIn, "whatsapp", true);
    await setBillingPref(orgId, optedOut, "whatsapp", false);

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${levyId}/remind`)
      .send({ channel: "whatsapp" })
      .expect(200);

    expect(res.body.sentCount).toBe(1);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.skippedCount).toBe(1);

    // sendBroadcast must NOT be called for the opted-out member.
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    const skippedRows = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, optedOut),
        eq(memberMessagesTable.relatedEntityId, levyId),
        eq(memberMessagesTable.status, "skipped"),
      ));
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].channel).toBe("whatsapp");
    expect(skippedRows[0].errorMessage ?? "").toContain("opted out");

    const sentRows = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, optedIn),
        eq(memberMessagesTable.relatedEntityId, levyId),
        eq(memberMessagesTable.status, "sent"),
      ));
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].channel).toBe("whatsapp");
  });

  it("schema default: a member with NO member_comm_prefs row is treated as opted-out for whatsapp", async () => {
    const orgId = await makeOrg("default-remind");
    const admin = await makeAdmin(orgId);
    const noPrefs = await makeMember(orgId, "Defaulty");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [noPrefs]);
    // Intentionally do NOT insert a memberCommPrefsTable row.

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${levyId}/remind`)
      .send({ channel: "whatsapp" })
      .expect(200);

    expect(res.body.sentCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.skippedCount).toBe(1);
    expect(broadcastMock).not.toHaveBeenCalled();

    const skipped = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, noPrefs),
        eq(memberMessagesTable.status, "skipped"),
      ));
    expect(skipped).toHaveLength(1);
    expect(skipped[0].channel).toBe("whatsapp");
  });

  it("schema default: SMS is also opted-out by default (default smsEnabled=false)", async () => {
    const orgId = await makeOrg("default-sms");
    const admin = await makeAdmin(orgId);
    const noPrefs = await makeMember(orgId, "Defaulty");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [noPrefs]);

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${levyId}/remind`)
      .send({ channel: "sms" })
      .expect(200);

    expect(res.body.sentCount).toBe(0);
    expect(res.body.skippedCount).toBe(1);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("POST /levies/:id/retry-failed — per-channel opt-out (Task #343)", () => {
  it("retry honours a flipped whatsapp opt-out: opted-out member is skipped, opted-in member retries", async () => {
    const orgId = await makeOrg("retry");
    const admin = await makeAdmin(orgId);
    const optedIn = await makeMember(orgId, "RetryIn");
    const optedOut = await makeMember(orgId, "RetryOut");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [optedIn, optedOut]);

    // Seed a prior failed WhatsApp reminder for both members.
    await insertPriorFailedWhatsApp(orgId, optedIn, levyId);
    await insertPriorFailedWhatsApp(orgId, optedOut, levyId);

    // Now flip the per-channel opt-out for one member (this is the Task #343
    // scenario: member updates their billing prefs between the original
    // failed send and the admin's retry click).
    await setBillingPref(orgId, optedIn, "whatsapp", true);
    await setBillingPref(orgId, optedOut, "whatsapp", false);

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${levyId}/retry-failed`)
      .send({})
      .expect(200);

    expect(res.body.retriedCount).toBe(2);
    expect(res.body.sentCount).toBe(1);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.skippedCount).toBe(1);

    // The opted-out member must NOT be re-broadcast.
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    const skippedRetry = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, optedOut),
        eq(memberMessagesTable.relatedEntityId, levyId),
        eq(memberMessagesTable.status, "skipped"),
      ));
    expect(skippedRetry).toHaveLength(1);
    expect(skippedRetry[0].channel).toBe("whatsapp");
    expect(skippedRetry[0].errorMessage ?? "").toContain("opted out");

    // The original failed rows are preserved (audit trail).
    const stillFailed = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.relatedEntityId, levyId),
        eq(memberMessagesTable.status, "failed"),
      ));
    expect(stillFailed).toHaveLength(2);
  });

  it("schema default: a member with NO member_comm_prefs row is treated as opted-out on retry too", async () => {
    const orgId = await makeOrg("retry-default");
    const admin = await makeAdmin(orgId);
    const noPrefs = await makeMember(orgId, "Defaulty");
    const levyId = await makeLevy(orgId, "Annual Levy");
    await chargeMembers(levyId, [noPrefs]);
    await insertPriorFailedWhatsApp(orgId, noPrefs, levyId);

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${levyId}/retry-failed`)
      .send({})
      .expect(200);

    expect(res.body.retriedCount).toBe(1);
    expect(res.body.sentCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.skippedCount).toBe(1);
    expect(broadcastMock).not.toHaveBeenCalled();

    const skipped = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, noPrefs),
        eq(memberMessagesTable.status, "skipped"),
      ));
    expect(skipped).toHaveLength(1);
  });
});
