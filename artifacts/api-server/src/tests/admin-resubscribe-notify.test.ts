/**
 * Task #1401 — when an org_admin / tournament_director clears another
 * member's tie-break or bounced-digest schedule-change opt-out via the
 * admin DELETE endpoints (Tasks #1208 + #512), the affected member gets a
 * low-key in-app inbox row telling them who turned the email back on, and
 * a one-click link (using the same HMAC-signed token the email helpers
 * use) to opt back out.
 *
 * Task #1692 extends the same DELETE handlers to also dispatch a
 * transactional email so a director who only checks email (and never
 * opens the mobile app) still gets the heads-up. The email is best-effort
 * and respects `userNotificationPrefs.preferEmail` plus, for the
 * tie-break flow, the same per-category `memberCommPrefs.tournaments`
 * toggle that the round-robin tie-break alert email already honours.
 *
 * Coverage:
 *   - DELETE /api/organizations/:orgId/tie-break-email-opt-outs/:userId
 *     writes an inbox row to the affected member when they have a
 *     club_members row in the org, with a re-opt-out URL whose token
 *     verifies back to (userId, orgId).
 *   - DELETE /api/organizations/:orgId/bounced-digest-schedule-opt-outs
 *     /:userId does the same against the bounced-digest unsubscribe handler.
 *   - The helpers are best-effort: an affected member with no club_members
 *     row gets no inbox row and the DELETE still succeeds.
 *   - Off-club director fallback (Task #1693): when the affected user has
 *     no club_members row in the org, both helpers fan out a push
 *     notification (via sendPushToUsers) instead of leaving the recipient
 *     in the dark. Push delivery honours `userNotificationPrefs.preferPush`.
 *   - Real-time heads-up (Task #2115): push ALSO fires alongside the
 *     inbox row + email for in-club directors so directors who rely on
 *     push or who don't routinely check email get a real-time signal.
 *     Honours the same comm-pref category gate as email
 *     (`memberCommPrefs.tournaments.pushEnabled` for tie-break, no
 *     per-category gate for bounced-digest), plus
 *     `userNotificationPrefs.preferPush`. A push failure must NOT fail
 *     the surrounding DELETE (best-effort).
 *   - The idempotent re-call (no opt-out row to delete) does NOT spam a
 *     second inbox row.
 *   - Both DELETE handlers also dispatch a transactional email carrying
 *     the same signed unsubscribe URL — and the email is suppressed when
 *     the affected user has set `preferEmail = false` (tie-break + digest)
 *     or disabled the per-category `tournaments` member-comm pref
 *     (tie-break only).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  roundRobinTieBreakEmailOptOutsTable,
  bouncedDigestScheduleOptOutsTable,
  userNotificationPrefsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];

import { createTestApp, type TestUser, uid } from "./helpers.js";
import {
  verifyTieBreakEmailOptOutToken,
  verifyBouncedDigestScheduleOptOutToken,
} from "../lib/bouncedDigestUnsubscribe.js";
import { sendPushToUsers } from "../lib/push.js";

const pushMock = vi.mocked(sendPushToUsers);

// Stub the new transactional email helper so tests can assert it was called
// with the right shape without going through the SMTP/Postmark adapter.
const sentEmails: Array<Record<string, unknown>> = [];
vi.mock("../lib/mailer.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    sendAdminResubscribedAlertEmail: vi.fn(async (opts: Record<string, unknown>) => {
      sentEmails.push(opts);
    }),
  };
});

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-admin-resubscribe-notify";
  }
});

async function makeOrg(label: string): Promise<{ id: number; name: string }> {
  const tag = uid(label);
  const name = `T1401_${tag}`;
  const [o] = await db.insert(organizationsTable).values({
    name,
    slug: `t1401-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return { id: o.id, name };
}

async function makeUser(orgId: number | null, role: OrgRole, displayName?: string): Promise<TestUser> {
  const tag = uid(role);
  const dn = displayName ?? role;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: dn,
    role,
    organizationId: (role === "org_admin" || role === "tournament_director") ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: dn,
    role,
    organizationId: (role === "org_admin" || role === "tournament_director") ? (orgId ?? undefined) : undefined,
  };
}

async function makeClubMember(orgId: number, userId: number): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Resub",
    lastName: "Director",
  }).returning({ id: clubMembersTable.id });
  return m.id;
}

beforeEach(() => {
  pushMock.mockClear();
});

afterAll(async () => {
  if (createdOrgIds.length) {
    const memberRows = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(inArray(clubMembersTable.organizationId, createdOrgIds));
    const memberIds = memberRows.map(r => r.id);
    if (memberIds.length) {
      await db.delete(memberCommPrefsTable).where(inArray(memberCommPrefsTable.clubMemberId, memberIds));
    }
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.organizationId, createdOrgIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.organizationId, createdOrgIds));
    await db.delete(roundRobinTieBreakEmailOptOutsTable).where(inArray(roundRobinTieBreakEmailOptOutsTable.organizationId, createdOrgIds));
    await db.delete(bouncedDigestScheduleOptOutsTable).where(inArray(bouncedDigestScheduleOptOutsTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function fetchInbox(orgId: number, clubMemberId: number) {
  return db
    .select()
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.clubMemberId, clubMemberId),
    ));
}

describe("DELETE /api/organizations/:orgId/tie-break-email-opt-outs/:userId — Task #1401 inbox notice", () => {
  it("drops an inbox row on the affected member with a signed re-opt-out link", async () => {
    const org = await makeOrg("tb_inbox");
    const admin = await makeUser(org.id, "org_admin", "Pat Admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    const row = inbox[0];
    expect(row.relatedEntity).toBe("tie_break_email_admin_resubscribe");
    expect(row.relatedEntityId).toBe(director.id);
    expect(row.channel).toBe("in_app");
    expect(row.status).toBe("sent");
    expect(row.senderUserId).toBe(admin.id);
    expect(row.subject ?? "").toMatch(/tie-break/i);
    expect(row.body).toContain("Pat Admin");
    expect(row.body).toContain(org.name);

    // The inbox body must contain a token-bearing unsubscribe link that
    // verifies back to (director.id, org.id).
    const tokenMatch = row.body.match(/[?&]token=([^\s&]+)/);
    expect(tokenMatch?.[1]).toBeTruthy();
    const decoded = decodeURIComponent(tokenMatch![1]);
    expect(verifyTieBreakEmailOptOutToken(decoded)).toEqual({
      userId: director.id,
      orgId: org.id,
    });
    expect(row.body).toContain("/api/public/tie-break-email-unsubscribe");
  });

  it("does not write an inbox row when no opt-out row was actually cleared", async () => {
    const org = await makeOrg("tb_idem");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);

    // No opt-out row pre-seeded — the DELETE is a no-op so nothing should
    // land in the inbox.
    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(0);
  });

  it("falls back to a push notification when the affected user has no club_members row (Task #1693)", async () => {
    const org = await makeOrg("tb_no_member");
    const admin = await makeUser(org.id, "org_admin", "Pat Admin");
    const director = await makeUser(org.id, "tournament_director", "Off Club Director");
    // Intentionally no club_members row — this director only manages
    // tournaments and isn't a paying club member.
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    // No inbox row (no club_member to key off), but a push must have
    // been fanned out to the off-club director instead.
    const inbox = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.organizationId, org.id));
    expect(inbox).toHaveLength(0);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = pushMock.mock.calls[0];
    expect(userIds).toEqual([director.id]);
    expect(title).toMatch(/tie-break/i);
    expect(body).toContain("Pat Admin");
    expect(body).toContain(org.name);
    expect(body).toMatch(/opt out/i);
    expect(data).toMatchObject({
      type: "tie_break_email_admin_resubscribe",
      organizationId: org.id,
      userId: director.id,
      actorUserId: admin.id,
      deepLink: "/my-360/communications",
    });
  });

  it("honours preferPush=false on the off-club fallback (no push sent)", async () => {
    const org = await makeOrg("tb_no_member_optout");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "tournament_director");
    await db.insert(userNotificationPrefsTable).values({
      userId: director.id,
      preferPush: false,
    });
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(pushMock).not.toHaveBeenCalled();
    const inbox = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.organizationId, org.id));
    expect(inbox).toHaveLength(0);
  });

  it("attributes the inbox row to a tournament_director actor too", async () => {
    const org = await makeOrg("tb_td_actor");
    const td = await makeUser(org.id, "tournament_director", "Lee Director");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(td))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].senderUserId).toBe(td.id);
    expect(inbox[0].body).toContain("Lee Director");
    expect(inbox[0].body).toContain(org.name);
  });
});

describe("DELETE /api/organizations/:orgId/bounced-digest-schedule-opt-outs/:userId — Task #1401 inbox notice", () => {
  it("drops an inbox row on the affected member with a signed re-opt-out link", async () => {
    const org = await makeOrg("bd_inbox");
    const admin = await makeUser(org.id, "org_admin", "Sam Admin");
    const member = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, member.id);
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    const row = inbox[0];
    expect(row.relatedEntity).toBe("bounced_digest_schedule_admin_resubscribe");
    expect(row.relatedEntityId).toBe(member.id);
    expect(row.senderUserId).toBe(admin.id);
    expect(row.subject ?? "").toMatch(/bounced-reminders/i);
    expect(row.body).toContain("Sam Admin");
    expect(row.body).toContain(org.name);

    const tokenMatch = row.body.match(/[?&]token=([^\s&]+)/);
    expect(tokenMatch?.[1]).toBeTruthy();
    const decoded = decodeURIComponent(tokenMatch![1]);
    expect(verifyBouncedDigestScheduleOptOutToken(decoded)).toEqual({
      userId: member.id,
      orgId: org.id,
    });
    expect(row.body).toContain("/api/public/bounced-digest-schedule-unsubscribe");
  });

  it("does not write an inbox row when no opt-out row was actually cleared", async () => {
    const org = await makeOrg("bd_idem");
    const admin = await makeUser(org.id, "org_admin");
    const member = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, member.id);

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(0);
  });

  it("falls back to a push notification when the affected user has no club_members row (Task #1693)", async () => {
    const org = await makeOrg("bd_no_member");
    const admin = await makeUser(org.id, "org_admin", "Sam Admin");
    const member = await makeUser(org.id, "tournament_director", "Off Club Director");
    // Intentionally no club_members row — symmetry with the tie-break path.
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    const inbox = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.organizationId, org.id));
    expect(inbox).toHaveLength(0);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = pushMock.mock.calls[0];
    expect(userIds).toEqual([member.id]);
    expect(title).toMatch(/bounced-reminders/i);
    expect(body).toContain("Sam Admin");
    expect(body).toContain(org.name);
    expect(body).toMatch(/opt out/i);
    expect(data).toMatchObject({
      type: "bounced_digest_schedule_admin_resubscribe",
      organizationId: org.id,
      userId: member.id,
      actorUserId: admin.id,
      deepLink: "/my-360/communications",
    });
  });

  it("honours preferPush=false on the off-club fallback (no push sent)", async () => {
    const org = await makeOrg("bd_no_member_optout");
    const admin = await makeUser(org.id, "org_admin");
    const member = await makeUser(org.id, "tournament_director");
    await db.insert(userNotificationPrefsTable).values({
      userId: member.id,
      preferPush: false,
    });
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    expect(pushMock).not.toHaveBeenCalled();
    const inbox = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.organizationId, org.id));
    expect(inbox).toHaveLength(0);
  });
});

describe("Task #1692 — admin re-subscribed transactional email", () => {
  beforeAll(() => {
    sentEmails.length = 0;
  });

  it("dispatches a tie-break email carrying the same signed unsubscribe URL as the inbox row", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("tb_email");
    const admin = await makeUser(org.id, "org_admin", "Pat Admin");
    const director = await makeUser(org.id, "player", "Reese Director");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0];
    expect(typeof email.to).toBe("string");
    expect((email.to as string).endsWith("@test.local")).toBe(true);
    expect(email.flow).toBe("tie_break_admin_resubscribed");
    expect(email.subject).toMatch(/tie-break/i);
    expect(email.actorName).toBe("Pat Admin");
    expect(email.orgName).toBe(org.name);
    const unsub = email.unsubscribeUrl as string;
    expect(unsub).toContain("/api/public/tie-break-email-unsubscribe");
    const tokenMatch = unsub.match(/[?&]token=([^&]+)/);
    expect(tokenMatch?.[1]).toBeTruthy();
    const decoded = decodeURIComponent(tokenMatch![1]);
    expect(verifyTieBreakEmailOptOutToken(decoded)).toEqual({
      userId: director.id,
      orgId: org.id,
    });
    // Inbox row was still written too.
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
  });

  it("dispatches a bounced-digest email even when the affected user is not a club_member of the org", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("bd_email_no_member");
    const admin = await makeUser(org.id, "org_admin", "Sam Admin");
    const member = await makeUser(org.id, "player");
    // No club_members row — the inbox row is skipped, but the email still fires.
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0];
    expect(email.flow).toBe("bounced_digest_schedule_admin_resubscribed");
    expect(email.subject).toMatch(/bounced-reminders/i);
    expect((email.unsubscribeUrl as string)).toContain("/api/public/bounced-digest-schedule-unsubscribe");
    const inbox = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.organizationId, org.id));
    expect(inbox).toHaveLength(0);
  });

  it("suppresses the email when the affected user has preferEmail = false", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("tb_pref_email_off");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    await makeClubMember(org.id, director.id);
    await db.insert(userNotificationPrefsTable).values({
      userId: director.id, preferEmail: false,
    });
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(0);
  });

  it("suppresses the tie-break email when the per-category tournaments comm-pref is off", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("tb_cat_off");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: org.id,
      category: "tournaments",
      emailEnabled: false,
    });
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(0);
  });

  it("still dispatches the bounced-digest email when tournaments category is off (per-category gate is tie-break only)", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("bd_cat_off_ignored");
    const admin = await makeUser(org.id, "org_admin");
    const member = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, member.id);
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: org.id,
      category: "tournaments",
      emailEnabled: false,
    });
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].flow).toBe("bounced_digest_schedule_admin_resubscribed");
  });

  it("does not dispatch an email when no opt-out row was actually cleared", async () => {
    sentEmails.length = 0;
    const org = await makeOrg("tb_email_idem");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    await makeClubMember(org.id, director.id);
    // No opt-out row to begin with — DELETE is a no-op so the email fan-out
    // must NOT fire either.

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(sentEmails).toHaveLength(0);
  });

  it("returns 204 even when the email helper throws (best-effort delivery)", async () => {
    sentEmails.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailerMod = (await import("../lib/mailer.js")) as any;
    const sendSpy = vi
      .spyOn(mailerMod, "sendAdminResubscribedAlertEmail")
      .mockImplementationOnce(async () => {
        throw new Error("simulated SMTP outage");
      });

    const org = await makeOrg("tb_email_throws");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    // Inbox row still landed despite the email failure.
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    sendSpy.mockRestore();
  });
});

// Task #2115 — Push notification fires alongside the inbox row + email so
// directors who rely on push (or who don't routinely check email) get a
// real-time heads-up that an admin re-enabled their alerts. Honours the
// same comm-pref category gate as email + `userNotificationPrefs.preferPush`,
// and is best-effort so a push failure can't fail the surrounding DELETE.
describe("Task #2115 — admin re-subscribed real-time push heads-up", () => {
  it("dispatches a tie-break push alongside the inbox row for an in-club director", async () => {
    const org = await makeOrg("tb_push_inclub");
    const admin = await makeUser(org.id, "org_admin", "Pat Admin");
    const director = await makeUser(org.id, "player", "Reese Director");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    // Inbox row still landed for the in-club director.
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);

    // Push fanned out to the same director with the tie-break payload.
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = pushMock.mock.calls[0];
    expect(userIds).toEqual([director.id]);
    expect(title).toMatch(/tie-break/i);
    expect(body).toContain("Pat Admin");
    expect(body).toContain(org.name);
    expect(data).toMatchObject({
      type: "tie_break_email_admin_resubscribe",
      organizationId: org.id,
      userId: director.id,
      actorUserId: admin.id,
      deepLink: "/my-360/communications",
    });
  });

  it("dispatches a bounced-digest push alongside the inbox row for an in-club member", async () => {
    const org = await makeOrg("bd_push_inclub");
    const admin = await makeUser(org.id, "org_admin", "Sam Admin");
    const member = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, member.id);
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [userIds, , , data] = pushMock.mock.calls[0];
    expect(userIds).toEqual([member.id]);
    expect(data).toMatchObject({
      type: "bounced_digest_schedule_admin_resubscribe",
      organizationId: org.id,
      userId: member.id,
      actorUserId: admin.id,
    });
  });

  it("suppresses the tie-break push when the per-category memberCommPrefs.tournaments.pushEnabled is off", async () => {
    const org = await makeOrg("tb_push_cat_off");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    // Mirrors the email gate — a director who silenced the `tournaments`
    // category at the per-category level shouldn't get pinged on push
    // either when an admin re-enables them.
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: org.id,
      category: "tournaments",
      pushEnabled: false,
    });
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(pushMock).not.toHaveBeenCalled();
    // Inbox row still lands — the per-category push gate doesn't block
    // the inbox channel (in_app stays under separate user control).
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
  });

  it("still dispatches the bounced-digest push when tournaments.pushEnabled is off (per-category gate is tie-break only)", async () => {
    const org = await makeOrg("bd_push_cat_off_ignored");
    const admin = await makeUser(org.id, "org_admin");
    const member = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, member.id);
    // Set the category gate off — bounced-digest must ignore it.
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: org.id,
      category: "tournaments",
      pushEnabled: false,
    });
    await db.insert(bouncedDigestScheduleOptOutsTable).values({
      organizationId: org.id,
      userId: member.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/bounced-digest-schedule-opt-outs/${member.id}`)
      .expect(204);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toEqual([member.id]);
  });

  it("honours preferPush=false on the in-club push leg (inbox row still lands)", async () => {
    const org = await makeOrg("tb_push_pref_off");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(userNotificationPrefsTable).values({
      userId: director.id,
      preferPush: false,
    });
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    expect(pushMock).not.toHaveBeenCalled();
    // Inbox row still landed (preferPush gate is push-only).
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
  });

  it("returns 204 even when sendPushToUsers throws (best-effort push delivery)", async () => {
    pushMock.mockImplementationOnce(async () => {
      throw new Error("simulated Expo outage");
    });

    const org = await makeOrg("tb_push_throws");
    const admin = await makeUser(org.id, "org_admin");
    const director = await makeUser(org.id, "player");
    const memberId = await makeClubMember(org.id, director.id);
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: org.id,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${org.id}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    // Push transport blew up but the inbox row still landed and the
    // DELETE returned 204 — every other channel must remain intact.
    const inbox = await fetchInbox(org.id, memberId);
    expect(inbox).toHaveLength(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});
