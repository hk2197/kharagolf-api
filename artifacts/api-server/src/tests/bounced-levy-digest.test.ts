/**
 * Unit + integration tests for the daily bounced-levy reminders digest
 * (Tasks #242, #275).
 *
 * Covers:
 *   - getBouncedLeviesForOrg: latest-per-(member,channel) rollup, supersession
 *     by a later successful send, and per-channel breakdown.
 *   - sendBouncedLevyRemindersDigest end-to-end:
 *       * zero-failures days → no email is sent,
 *       * orgs with unresolved bounces → one email per admin recipient,
 *       * same UTC day → second invocation does NOT double-send,
 *       * email body contains the /club-members?openLevy=<id> deep link.
 *
 * The mailer is mocked so no real SMTP is hit; the DB is real so we exercise
 * the same aggregation + admin-recipient resolution the cron uses in prod.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendBouncedLevyDigestEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberLeviesTable,
  memberMessagesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { getBouncedLeviesForOrg } from "../lib/levyBouncedReminders.js";
import { sendBouncedLevyRemindersDigest } from "../lib/cron.js";
import { sendBouncedLevyDigestEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendBouncedLevyDigestEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdLevyIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `BouncedDigestTest_${label}_${tag}`,
    slug: `bounced-digest-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `bounced-digest-${tag}`,
    username: `bounced_digest_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeOrgAdmin(orgId: number, email: string, displayName: string): Promise<number> {
  const userId = await makeUser({ email, displayName });
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });
  return userId;
}

async function makeMember(orgId: number, firstName = "Test"): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName,
    lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function makeLevy(orgId: number, name: string): Promise<number> {
  const [l] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name,
    amount: "1000.00",
    currency: "INR",
  }).returning({ id: memberLeviesTable.id });
  createdLevyIds.push(l.id);
  return l.id;
}

async function insertMessage(opts: {
  orgId: number;
  memberId: number;
  levyId: number;
  channel: string;
  status: "sent" | "failed";
  sentAt: Date;
  errorMessage?: string | null;
}) {
  await db.insert(memberMessagesTable).values({
    organizationId: opts.orgId,
    clubMemberId: opts.memberId,
    channel: opts.channel,
    body: "reminder",
    status: opts.status,
    sentAt: opts.sentAt,
    errorMessage: opts.errorMessage ?? null,
    relatedEntity: "levy",
    relatedEntityId: opts.levyId,
  });
}

let prevAppBaseUrl: string | undefined;
beforeAll(() => {
  // Pin a deterministic base URL so we can assert the deep-link without
  // depending on the developer's REPLIT_DEV_DOMAIN.
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://test.kharagolf.com";
});

afterAll(async () => {
  if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevAppBaseUrl;
  if (createdLevyIds.length) {
    // member_messages reference the levy via relatedEntityId — clean those first.
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.relatedEntityId, createdLevyIds));
    await db.delete(memberLeviesTable).where(inArray(memberLeviesTable.id, createdLevyIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Unit: getBouncedLeviesForOrg
// ─────────────────────────────────────────────────────────────────────────
describe("getBouncedLeviesForOrg — latest-per-channel rollup & supersession", () => {
  it("returns an empty result for an org with no levy messages", async () => {
    const orgId = await makeOrg("empty");
    const res = await getBouncedLeviesForOrg(orgId);
    expect(res.totalBounced).toBe(0);
    expect(res.levies).toEqual([]);
  });

  it("counts the latest message per (member, channel) and ignores older failures", async () => {
    const orgId = await makeOrg("latest");
    const memberId = await makeMember(orgId);
    const levyId = await makeLevy(orgId, "Annual Subscription");

    // Same (member, email): older failed, then a newer SUCCESS — should be excluded.
    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "failed",
      sentAt: new Date("2025-01-01T10:00:00Z"), errorMessage: "bounce",
    });
    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "sent",
      sentAt: new Date("2025-01-02T10:00:00Z"),
    });

    const res = await getBouncedLeviesForOrg(orgId);
    expect(res.totalBounced).toBe(0);
    expect(res.levies).toEqual([]);
  });

  it("counts a still-failing channel even when a sibling channel later succeeded", async () => {
    const orgId = await makeOrg("siblings");
    const memberId = await makeMember(orgId);
    const levyId = await makeLevy(orgId, "Q1 Levy");

    // email is still failing (latest is failed).
    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "failed",
      sentAt: new Date("2025-02-01T10:00:00Z"), errorMessage: "smtp 550",
    });
    // sms succeeded — should NOT supersede the email channel's failure.
    await insertMessage({
      orgId, memberId, levyId, channel: "sms", status: "sent",
      sentAt: new Date("2025-02-02T10:00:00Z"),
    });

    const res = await getBouncedLeviesForOrg(orgId);
    expect(res.totalBounced).toBe(1);
    expect(res.levies).toHaveLength(1);
    expect(res.levies[0].levyId).toBe(levyId);
    expect(res.levies[0].channels).toEqual({ email: 1 });
    expect(res.levies[0].sampleError).toBe("smtp 550");
  });

  it("rolls up multiple members + channels into per-levy summaries", async () => {
    const orgId = await makeOrg("rollup");
    const m1 = await makeMember(orgId, "Alice");
    const m2 = await makeMember(orgId, "Bob");
    const levyId = await makeLevy(orgId, "Locker Fee");

    // Member 1 — email failed (latest).
    await insertMessage({
      orgId, memberId: m1, levyId, channel: "email", status: "failed",
      sentAt: new Date("2025-03-01T10:00:00Z"),
    });
    // Member 2 — both email and sms failed.
    await insertMessage({
      orgId, memberId: m2, levyId, channel: "email", status: "failed",
      sentAt: new Date("2025-03-01T11:00:00Z"),
    });
    await insertMessage({
      orgId, memberId: m2, levyId, channel: "sms", status: "failed",
      sentAt: new Date("2025-03-01T12:00:00Z"),
    });

    const res = await getBouncedLeviesForOrg(orgId);
    expect(res.totalBounced).toBe(3);
    expect(res.levies).toHaveLength(1);
    expect(res.levies[0].channels).toEqual({ email: 2, sms: 1 });
    // latestFailureAt is the most recent failure across all channels.
    expect(res.levies[0].latestFailureAt).toBe("2025-03-01T12:00:00.000Z");
  });

  it("includes whatsapp bounces alongside sms/email in the per-channel rollup (Task #299)", async () => {
    const orgId = await makeOrg("whatsapp");
    const memberId = await makeMember(orgId, "Whatsapp");
    const levyId = await makeLevy(orgId, "Q2 Levy");

    // whatsapp is still failing (latest is failed) — bad number / provider error.
    await insertMessage({
      orgId, memberId, levyId, channel: "whatsapp", status: "failed",
      sentAt: new Date("2025-05-01T10:00:00Z"), errorMessage: "msg91 invalid number",
    });
    // sibling sms succeeded — must NOT supersede the whatsapp failure.
    await insertMessage({
      orgId, memberId, levyId, channel: "sms", status: "sent",
      sentAt: new Date("2025-05-01T11:00:00Z"),
    });

    const res = await getBouncedLeviesForOrg(orgId);
    expect(res.totalBounced).toBe(1);
    expect(res.levies).toHaveLength(1);
    expect(res.levies[0].channels).toEqual({ whatsapp: 1 });
    expect(res.levies[0].sampleError).toBe("msg91 invalid number");
  });

  it("scopes results to the requested org", async () => {
    const orgA = await makeOrg("scopeA");
    const orgB = await makeOrg("scopeB");
    const memberB = await makeMember(orgB);
    const levyB = await makeLevy(orgB, "OrgB Levy");
    await insertMessage({
      orgId: orgB, memberId: memberB, levyId: levyB, channel: "email", status: "failed",
      sentAt: new Date("2025-04-01T10:00:00Z"),
    });

    const resA = await getBouncedLeviesForOrg(orgA);
    expect(resA.totalBounced).toBe(0);
    const resB = await getBouncedLeviesForOrg(orgB);
    expect(resB.totalBounced).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Integration: sendBouncedLevyRemindersDigest
// ─────────────────────────────────────────────────────────────────────────
describe("sendBouncedLevyRemindersDigest — end-to-end", () => {
  it("sends nothing when no org has any failed levy messages", async () => {
    // Fresh org with NO messages at all → cron's pre-filter excludes it.
    await makeOrg("zerofailures");
    await sendBouncedLevyRemindersDigest();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("sends nothing when every failure has been superseded by a later success", async () => {
    const orgId = await makeOrg("superseded");
    const memberId = await makeMember(orgId);
    const levyId = await makeLevy(orgId, "Resolved Levy");
    await makeOrgAdmin(orgId, "admin-superseded@example.com", "Superseded Admin");

    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "failed",
      sentAt: new Date("2025-05-01T10:00:00Z"),
    });
    // Later success on same (member, channel) clears it.
    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "sent",
      sentAt: new Date("2025-05-02T10:00:00Z"),
    });

    await sendBouncedLevyRemindersDigest();

    // Even though the org appears in the candidate list (it has a `failed`
    // row on record), the per-org rollup is empty so nothing is emailed.
    const callsForThisOrg = emailMock.mock.calls.filter(
      ([arg]) => arg.to === "admin-superseded@example.com",
    );
    expect(callsForThisOrg).toHaveLength(0);
  });

  it("emails one digest per org_admin with a deep link to /club-members?openLevy=<id>", async () => {
    const orgId = await makeOrg("delivers");
    const memberId = await makeMember(orgId);
    const levyId = await makeLevy(orgId, "Active Bounced Levy");
    await makeOrgAdmin(orgId, "admin1-delivers@example.com", "Admin One");
    await makeOrgAdmin(orgId, "admin2-delivers@example.com", "Admin Two");

    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "failed",
      sentAt: new Date(), errorMessage: "mailbox full",
    });

    await sendBouncedLevyRemindersDigest();

    const callsForOrg = emailMock.mock.calls
      .map(([arg]) => arg)
      .filter(arg =>
        arg.to === "admin1-delivers@example.com"
        || arg.to === "admin2-delivers@example.com",
      );
    expect(callsForOrg).toHaveLength(2);

    const recipients = new Set(callsForOrg.map(c => c.to));
    expect(recipients).toEqual(new Set([
      "admin1-delivers@example.com",
      "admin2-delivers@example.com",
    ]));

    for (const call of callsForOrg) {
      expect(call.totalBounced).toBe(1);
      expect(call.levies).toHaveLength(1);
      expect(call.levies[0].levyId).toBe(levyId);
      // Deep-link is built by the mailer template itself, but the cron must
      // pass a usable baseUrl that the template can append onto. Verify both.
      expect(call.baseUrl).toBe("https://test.kharagolf.com");
    }
  });

  it("does not double-send on the same UTC day across repeated invocations", async () => {
    const orgId = await makeOrg("dedup");
    const memberId = await makeMember(orgId);
    const levyId = await makeLevy(orgId, "Dedup Levy");
    await makeOrgAdmin(orgId, "admin-dedup@example.com", "Dedup Admin");

    await insertMessage({
      orgId, memberId, levyId, channel: "email", status: "failed",
      sentAt: new Date(),
    });

    await sendBouncedLevyRemindersDigest();
    const firstRunCalls = emailMock.mock.calls.filter(
      ([arg]) => arg.to === "admin-dedup@example.com",
    ).length;
    expect(firstRunCalls).toBe(1);

    // Second invocation on the same UTC day must skip this org entirely.
    emailMock.mockClear();
    await sendBouncedLevyRemindersDigest();
    const secondRunCalls = emailMock.mock.calls.filter(
      ([arg]) => arg.to === "admin-dedup@example.com",
    ).length;
    expect(secondRunCalls).toBe(0);
  });

  it("delivers the /club-members?openLevy=<id> deep link in the rendered email body", async () => {
    // We mocked the mailer above, so verify the template instead by
    // un-mocking just for this test and intercepting sendMail.
    vi.resetModules();
    vi.doMock("../lib/mailer.js", async (importActual) => {
      const actual = await importActual<typeof import("../lib/mailer.js")>();
      return actual;
    });
    const sendMailMock = vi.fn(async () => undefined);
    vi.doMock("nodemailer", () => ({
      default: {
        createTransport: () => ({ sendMail: sendMailMock, verify: async () => true }),
      },
      createTransport: () => ({ sendMail: sendMailMock, verify: async () => true }),
    }));

    const mailer = await import("../lib/mailer.js");
    await mailer.sendBouncedLevyDigestEmail({
      to: "deeplink@example.com",
      staffName: "Deep Link Admin",
      baseUrl: "https://test.kharagolf.com",
      totalBounced: 1,
      levies: [{
        levyId: 4242,
        name: "Deep Link Levy",
        currency: "INR",
        unresolvedFailedCount: 1,
        channels: { email: 1 },
        latestFailureAt: new Date().toISOString(),
        sampleError: "smtp 550",
      }],
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sendArg = (sendMailMock.mock.calls[0] as unknown as Array<{ html: string }>)[0];
    expect(sendArg.html).toContain("https://test.kharagolf.com/club-members?openLevy=4242");

    vi.doUnmock("nodemailer");
    vi.doUnmock("../lib/mailer.js");
    vi.resetModules();
  });
});
