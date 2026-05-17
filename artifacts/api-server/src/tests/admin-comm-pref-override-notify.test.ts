/**
 * Task #1504 — When an org_admin / tournament_director flips another
 * member's notification preference (currently `notifySideGameReceipts`)
 * via PUT /api/organizations/:orgId/members/:userId/notification-prefs,
 * the affected member must receive both:
 *
 *   - an in-app inbox row tagged `relatedEntity = "comm_prefs_admin_override"`
 *     so it shows up on their member-360 timeline, with the admin's name,
 *     the preference label, the new value, and (when supplied) the reason;
 *   - a transactional email to their address (only when their
 *     `userNotificationPrefsTable.preferEmail` flag is true — we honour
 *     existing channel preferences and never email an opted-out member).
 *
 * Self-service flips (member toggling via the portal endpoint, or an
 * admin flipping their own pref via the admin endpoint) MUST NOT trigger
 * the notice — that would spam the member about a change they made
 * themselves seconds ago.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendNotificationPrefAdminOverrideEmail: vi.fn(async () => undefined),
  };
});

import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@workspace/db";
import {
  organizationsTable,
  orgMembershipsTable,
  appUsersTable,
  clubMembersTable,
  memberMessagesTable,
  userNotificationPrefsTable,
  memberAuditLogTable,
  orgRoleEnum,
} from "@workspace/db";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import { sendNotificationPrefAdminOverrideEmail } from "../lib/mailer.js";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];

const emailMock = vi.mocked(sendNotificationPrefAdminOverrideEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-admin-comm-pref-override";
  }
});

async function makeOrg(label: string): Promise<{ id: number; name: string }> {
  const tag = uid(label);
  const name = `T1504_${tag}`;
  const [o] = await db.insert(organizationsTable).values({
    name,
    slug: `t1504-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return { id: o.id, name };
}

async function makeUser(orgId: number | null, role: OrgRole, displayName?: string, email?: string): Promise<TestUser> {
  const tag = uid(role);
  const dn = displayName ?? role;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: email ?? `${tag}@test.local`,
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

async function joinOrg(orgId: number, userId: number, role: "org_admin" | "player" = "player"): Promise<void> {
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role,
  });
}

async function makeClubMember(orgId: number, userId: number): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Pref",
    lastName: "Target",
  }).returning({ id: clubMembersTable.id });
  return m.id;
}

afterAll(async () => {
  // Wait one tick so the route's fire-and-forget notify call settles
  // before we tear down the rows it inserts.
  await new Promise((r) => setTimeout(r, 200));

  if (createdOrgIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.organizationId, createdOrgIds));
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.organizationId, createdOrgIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined as unknown as void);
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

async function waitForInbox(orgId: number, clubMemberId: number, expectedCount: number, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await fetchInbox(orgId, clubMemberId);
    if (rows.length >= expectedCount) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fetchInbox(orgId, clubMemberId);
}

async function waitForEmailCall(timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (emailMock.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("PUT /api/organizations/:orgId/members/:userId/notification-prefs — Task #1504 notify", () => {
  it("writes an in-app inbox row and emails the member when an admin flips their pref", async () => {
    const org = await makeOrg("notify_send");
    const admin = await makeUser(org.id, "org_admin", "Pat Admin");
    await joinOrg(org.id, admin.id, "org_admin");
    const member = await makeUser(null, "player", "Sam Member", `sam-${uid("m")}@test.local`);
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id);

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${member.id}/notification-prefs`)
      .send({ notifySideGameReceipts: false, reason: "Member asked treasurer to silence receipts during travel." });

    expect(resp.status).toBe(200);
    expect(resp.body.notifySideGameReceipts).toBe(false);

    const inbox = await waitForInbox(org.id, cmId, 1);
    expect(inbox.length).toBe(1);
    const row = inbox[0];
    expect(row.relatedEntity).toBe("comm_prefs_admin_override");
    expect(row.relatedEntityId).toBe(member.id);
    expect(row.senderUserId).toBe(admin.id);
    expect(row.channel).toBe("in_app");
    expect(row.body).toContain("Pat Admin");
    expect(row.body).toContain("turned OFF");
    expect(row.body).toContain("Side-game settlement receipts");
    expect(row.body).toContain("Member asked treasurer to silence receipts during travel.");

    await waitForEmailCall();
    expect(emailMock).toHaveBeenCalledTimes(1);
    const emailArgs = emailMock.mock.calls[0]![0]!;
    expect(emailArgs.to).toMatch(/^sam-/);
    expect(emailArgs.adminName).toBe("Pat Admin");
    expect(emailArgs.memberName).toBe("Sam Member");
    expect(emailArgs.prefLabel).toMatch(/Side-game settlement receipts/);
    expect(emailArgs.newValue).toBe(false);
    expect(emailArgs.previousValue).toBe(true);
    expect(emailArgs.reason).toMatch(/silence receipts during travel/);
    expect(emailArgs.branding?.orgName).toBe(org.name);
  });

  it("respects preferEmail=false — inbox row still written, no email sent", async () => {
    const org = await makeOrg("notify_optout");
    const admin = await makeUser(org.id, "org_admin", "Casey Admin");
    await joinOrg(org.id, admin.id, "org_admin");
    const member = await makeUser(null, "player", "Riley Optout", `riley-${uid("m")}@test.local`);
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id);

    // Member has globally opted out of email notifications.
    await db.insert(userNotificationPrefsTable).values({
      userId: member.id,
      preferEmail: false,
    });

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${member.id}/notification-prefs`)
      .send({ notifySideGameReceipts: false, reason: "Compliance audit" });

    expect(resp.status).toBe(200);

    const inbox = await waitForInbox(org.id, cmId, 1);
    expect(inbox.length).toBe(1);
    expect(inbox[0].relatedEntity).toBe("comm_prefs_admin_override");

    // Give the route's fire-and-forget call time to potentially run.
    await new Promise((r) => setTimeout(r, 200));
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does NOT notify when an admin toggles their OWN notifySideGameReceipts via the admin endpoint", async () => {
    const org = await makeOrg("notify_self");
    const admin = await makeUser(org.id, "org_admin", "Self Admin", `selfadmin-${uid("m")}@test.local`);
    await joinOrg(org.id, admin.id, "org_admin");
    const cmId = await makeClubMember(org.id, admin.id);

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${admin.id}/notification-prefs`)
      .send({ notifySideGameReceipts: false });

    expect(resp.status).toBe(200);

    // Give the route a moment in case anything fires asynchronously.
    await new Promise((r) => setTimeout(r, 200));
    const inbox = await fetchInbox(org.id, cmId);
    expect(inbox.length).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  // ── Task #1846 — non-side-game pref end-to-end coverage ──────────────
  // The route iterates over every TOGGLEABLE_FIELDS key and fires one
  // notify per actually-changed pref. The original test above only
  // exercised `notifySideGameReceipts`; without coverage for at least
  // one channel pref it was possible for a regression in either the
  // route loop or the `ADMIN_OVERRIDABLE_PREF_LABELS` map to ship a
  // raw machine key (e.g. "preferWhatsapp") in the inbox/email body
  // while side-game-only tests stayed green. This test pins the
  // contract end-to-end for a non-side-game key.
  it("notifies the member when an admin flips a CHANNEL pref (preferWhatsapp ON)", async () => {
    const org = await makeOrg("notify_channel");
    const admin = await makeUser(org.id, "org_admin", "Robin Admin");
    await joinOrg(org.id, admin.id, "org_admin");
    const member = await makeUser(null, "player", "Jordan Member", `jordan-${uid("m")}@test.local`);
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id);

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${member.id}/notification-prefs`)
      .send({ preferWhatsapp: true, reason: "Member asked for WhatsApp updates by phone" });

    expect(resp.status).toBe(200);
    expect(resp.body.preferWhatsapp).toBe(true);

    const inbox = await waitForInbox(org.id, cmId, 1);
    expect(inbox.length).toBe(1);
    const row = inbox[0];
    expect(row.relatedEntity).toBe("comm_prefs_admin_override");
    expect(row.relatedEntityId).toBe(member.id);
    expect(row.senderUserId).toBe(admin.id);
    expect(row.body).toContain("Robin Admin");
    expect(row.body).toContain("turned ON");
    // Must use the human label from ADMIN_OVERRIDABLE_PREF_LABELS, NOT
    // the raw "preferWhatsapp" machine key.
    expect(row.body).toContain("WhatsApp notifications");
    expect(row.body).not.toContain("preferWhatsapp");
    expect(row.body).toContain("Member asked for WhatsApp updates by phone");

    await waitForEmailCall();
    expect(emailMock).toHaveBeenCalledTimes(1);
    const emailArgs = emailMock.mock.calls[0]![0]!;
    expect(emailArgs.to).toMatch(/^jordan-/);
    expect(emailArgs.adminName).toBe("Robin Admin");
    expect(emailArgs.memberName).toBe("Jordan Member");
    expect(emailArgs.prefLabel).toBe("WhatsApp notifications");
    expect(emailArgs.newValue).toBe(true);
    expect(emailArgs.previousValue).toBe(false);
    expect(emailArgs.reason).toMatch(/WhatsApp updates by phone/);
  });

  // Task #1846 — Channel-self-opt-out guard. When the override IS the
  // email channel itself being turned OFF, we MUST NOT email the
  // override notice (the member just opted out of email — sending one
  // anyway would be the "don't WhatsApp them about a WhatsApp opt-out"
  // footgun the override notice was meant to prevent). The inbox row
  // is still written because the inbox is the canonical consent trail
  // and is unaffected by per-channel preferences.
  it("does NOT email when the override IS preferEmail being turned OFF (channel-self-opt-out)", async () => {
    const org = await makeOrg("notify_email_off");
    const admin = await makeUser(org.id, "org_admin", "Morgan Admin");
    await joinOrg(org.id, admin.id, "org_admin");
    const member = await makeUser(null, "player", "Avery Member", `avery-${uid("m")}@test.local`);
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id);

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${member.id}/notification-prefs`)
      .send({ preferEmail: false, reason: "Member asked to silence all email" });

    expect(resp.status).toBe(200);
    expect(resp.body.preferEmail).toBe(false);

    // Inbox row must still be written — consent trail is channel-agnostic.
    const inbox = await waitForInbox(org.id, cmId, 1);
    expect(inbox.length).toBe(1);
    expect(inbox[0].relatedEntity).toBe("comm_prefs_admin_override");
    expect(inbox[0].body).toContain("Email notifications");
    expect(inbox[0].body).toContain("turned OFF");

    // Give the route's fire-and-forget call time to potentially run.
    await new Promise((r) => setTimeout(r, 200));
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does NOT notify when the value is unchanged (no-op admin save)", async () => {
    const org = await makeOrg("notify_noop");
    const admin = await makeUser(org.id, "org_admin", "Noop Admin");
    await joinOrg(org.id, admin.id, "org_admin");
    const member = await makeUser(null, "player", "Noop Member", `noop-${uid("m")}@test.local`);
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id);
    // Pre-populate prefs with the same value the admin will "save".
    await db.insert(userNotificationPrefsTable).values({
      userId: member.id,
      notifySideGameReceipts: true,
    });

    const app = createTestApp(admin);
    const resp = await request(app)
      .put(`/api/organizations/${org.id}/members/${member.id}/notification-prefs`)
      .send({ notifySideGameReceipts: true });

    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    const inbox = await fetchInbox(org.id, cmId);
    expect(inbox.length).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });
});
