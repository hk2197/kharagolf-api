/**
 * Task #1933 — Catch silent breakage of the admin email-change notification.
 *
 * Task #1549 wired a new transactional notice + in-app inbox row into the
 * suppression re-enable flow (Task #1311 — POST /suppressions/:id/reenable),
 * but the helper is best-effort: every failure is caught and logged so the
 * route still returns 200 even when the email send or the inbox insert
 * silently breaks.
 *
 * That makes the contract uniquely fragile to refactors. This file is the
 * regression net: it exercises both the helper directly AND the route that
 * calls it, mocking the mailer the same way the rest of the suite does
 * (mirrors `portal-data-export-notify.test.ts` /
 * `admin-comm-pref-override-notify.test.ts`).
 *
 * Coverage:
 *   - notifyMemberOfAdminEmailReplacement skips on self-action and on
 *     missing user (no email, no inbox row).
 *   - It writes exactly one `member_messages` row when a `club_members`
 *     row exists for the affected user in the org.
 *   - It calls `sendAccountEmailChangedByAdminEmail` with the new email,
 *     the member's `preferredLanguage`, and the org branding (orgName,
 *     logoUrl, primaryColor, orgId).
 *   - The marketing.ts /suppressions/:id/reenable handler triggers the
 *     notify exactly once per updated user when `replacementEmail` is set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendAccountEmailChangedByAdminEmail: vi.fn(async () => undefined),
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
  emailSuppressionsTable,
  memberMessagesTable,
  memberAuditLogTable,
  userNotificationPrefsTable,
} from "@workspace/db";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import { sendAccountEmailChangedByAdminEmail } from "../lib/mailer.js";
import { notifyMemberOfAdminEmailReplacement } from "../lib/adminEmailReplacementNotify.js";

const emailMock = vi.mocked(sendAccountEmailChangedByAdminEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdSuppressionIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-admin-email-replacement-notify";
  }
});

async function makeOrg(label: string, opts?: { logoUrl?: string; primaryColor?: string }): Promise<{
  id: number;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}> {
  const tag = uid(label);
  const name = `T1933_${tag}`;
  const [o] = await db.insert(organizationsTable).values({
    name,
    slug: `t1933-${tag}`.toLowerCase(),
    logoUrl: opts?.logoUrl ?? null,
    primaryColor: opts?.primaryColor ?? null,
  }).returning({
    id: organizationsTable.id,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  });
  createdOrgIds.push(o.id);
  return { id: o.id, name, logoUrl: o.logoUrl ?? null, primaryColor: o.primaryColor ?? null };
}

type SupportedLanguage = typeof appUsersTable.$inferInsert.preferredLanguage;

async function makeUser(opts: {
  orgId?: number | null;
  role?: "org_admin" | "player";
  displayName?: string;
  email?: string;
  preferredLanguage?: SupportedLanguage;
}): Promise<{ user: TestUser; email: string }> {
  const role = opts.role ?? "player";
  const tag = uid(role);
  const email = opts.email ?? `${tag}@test.local`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email,
    displayName: opts.displayName ?? role,
    role,
    organizationId: role === "org_admin" ? (opts.orgId ?? null) : null,
    preferredLanguage: opts.preferredLanguage ?? "en",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    user: {
      id: u.id,
      username: tag,
      displayName: opts.displayName ?? role,
      role,
      organizationId: role === "org_admin" ? (opts.orgId ?? undefined) : undefined,
    },
    email,
  };
}

async function joinOrg(orgId: number, userId: number, role: "org_admin" | "player" = "player"): Promise<void> {
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role,
  });
}

async function makeClubMember(orgId: number, userId: number, email: string): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Reenable",
    lastName: "Target",
    email,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function makeBouncedSuppression(orgId: number, email: string): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    reason: "bounced",
    bounceType: "BadMailbox",
    description: "Mailbox does not exist",
  }).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  // Wait for any fire-and-forget catches inside the route to settle.
  await new Promise((r) => setTimeout(r, 200));

  if (createdOrgIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.organizationId, createdOrgIds));
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
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

describe("notifyMemberOfAdminEmailReplacement — direct helper contract", () => {
  it("skips on self-action without sending email or writing inbox row", async () => {
    const org = await makeOrg("self");
    const { user: admin } = await makeUser({ orgId: org.id, role: "org_admin", displayName: "Self Admin" });
    await joinOrg(org.id, admin.id, "org_admin");
    // The actor IS the affected user — the helper must short-circuit.
    const cmId = await makeClubMember(org.id, admin.id, "self-old@test.local");

    const result = await notifyMemberOfAdminEmailReplacement({
      organizationId: org.id,
      affectedUserId: admin.id,
      actor: { id: admin.id, displayName: admin.displayName, email: "self-old@test.local" },
      previousEmail: "self-old@test.local",
      newEmail: "self-new@test.local",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("self_action");
    expect(emailMock).not.toHaveBeenCalled();

    const inbox = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.organizationId, org.id),
      eq(memberMessagesTable.clubMemberId, cmId),
    ));
    expect(inbox.length).toBe(0);
  });

  it("skips when the target user no longer exists", async () => {
    const org = await makeOrg("missing");
    const { user: admin } = await makeUser({ orgId: org.id, role: "org_admin", displayName: "Ghost Hunter" });
    await joinOrg(org.id, admin.id, "org_admin");

    const result = await notifyMemberOfAdminEmailReplacement({
      organizationId: org.id,
      // Not a real user id — drives the `target_user_not_found` branch.
      affectedUserId: 2_147_483_000,
      actor: { id: admin.id, displayName: admin.displayName, email: "admin@test.local" },
      previousEmail: "ghost-old@test.local",
      newEmail: "ghost-new@test.local",
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("target_user_not_found");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("writes one member_messages row and emails the new address with branding + preferredLanguage", async () => {
    const org = await makeOrg("happy", {
      logoUrl: "https://example.test/logo.png",
      primaryColor: "#abcdef",
    });
    const { user: admin } = await makeUser({ orgId: org.id, role: "org_admin", displayName: "Pat Admin" });
    await joinOrg(org.id, admin.id, "org_admin");

    const previousEmail = `old-${uid("m")}@test.local`;
    const newEmail = `new-${uid("m")}@test.local`;
    const { user: member } = await makeUser({
      role: "player",
      displayName: "Sam Member",
      email: previousEmail,
      preferredLanguage: "hi",
    });
    await joinOrg(org.id, member.id, "player");
    const cmId = await makeClubMember(org.id, member.id, previousEmail);

    const result = await notifyMemberOfAdminEmailReplacement({
      organizationId: org.id,
      affectedUserId: member.id,
      actor: { id: admin.id, displayName: admin.displayName, email: "pat@test.local" },
      previousEmail,
      newEmail,
    });

    // Helper reports overall success — both email + in-app land.
    expect(result.status).toBe("sent");
    expect(result.email.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(typeof result.inApp.messageId).toBe("number");

    // Exactly one inbox row is written, anchored to the affected member's
    // club_members row and tagged with the canonical relatedEntity.
    const inbox = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.organizationId, org.id),
      eq(memberMessagesTable.clubMemberId, cmId),
    ));
    expect(inbox.length).toBe(1);
    const row = inbox[0];
    expect(row.relatedEntity).toBe("account_email_changed_by_admin");
    expect(row.relatedEntityId).toBe(member.id);
    expect(row.senderUserId).toBe(admin.id);
    expect(row.channel).toBe("in_app");
    expect((row.subject ?? "")).toContain(org.name);
    expect(row.body).toContain("Pat Admin");
    expect(row.body).toContain(newEmail);
    expect(row.body).toContain(previousEmail);

    // Mailer dispatched once, to the NEW address, with the recipient's
    // preferredLanguage and the resolved org branding.
    expect(emailMock).toHaveBeenCalledTimes(1);
    const args = emailMock.mock.calls[0]![0]!;
    expect(args.to).toBe(newEmail);
    expect(args.newEmail).toBe(newEmail);
    expect(args.previousEmail).toBe(previousEmail);
    expect(args.preferredLanguage).toBe("hi");
    expect(args.adminName).toBe("Pat Admin");
    expect(args.memberName).toBe("Sam Member");
    expect(args.changedAt).toBeInstanceOf(Date);
    expect(args.branding?.orgName).toBe(org.name);
    expect(args.branding?.logoUrl).toBe("https://example.test/logo.png");
    expect(args.branding?.primaryColor).toBe("#abcdef");
    expect(args.branding?.orgId).toBe(org.id);
  });
});

describe("POST /suppressions/:id/reenable — Task #1549 notify wiring", () => {
  it("triggers the email notify exactly once per updated user when replacementEmail is set", async () => {
    const org = await makeOrg("route");
    const { user: admin } = await makeUser({ orgId: org.id, role: "org_admin", displayName: "Robin Admin" });
    await joinOrg(org.id, admin.id, "org_admin");

    // Affected member: app_user with `email = oldEmail` AND a matching
    // club_members row, joined into the org via org_memberships so the
    // route's `matchedUsers` query (joined on org_memberships) finds them.
    const oldEmail = `old-route-${uid("m")}@test.local`;
    const newEmail = `new-route-${uid("m")}@test.local`;
    const { user: affected } = await makeUser({
      role: "player",
      displayName: "Jordan Member",
      email: oldEmail,
      preferredLanguage: "en",
    });
    await joinOrg(org.id, affected.id, "player");
    await makeClubMember(org.id, affected.id, oldEmail);
    const supId = await makeBouncedSuppression(org.id, oldEmail);

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/organizations/${org.id}/marketing/suppressions/${supId}/reenable`)
      .send({ replacementEmail: newEmail, confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.replacementEmail).toBe(newEmail.toLowerCase());
    expect(res.body.updatedUserIds).toEqual([affected.id]);

    // The route awaits the notify Promise.all before responding — by the
    // time we get a 200 back, the mailer mock has been called exactly once
    // for the single matched user. (The route also fires a notify per
    // updated user; with one match we expect exactly one call.)
    expect(emailMock).toHaveBeenCalledTimes(1);
    const args = emailMock.mock.calls[0]![0]!;
    expect(args.to).toBe(newEmail.toLowerCase());
    expect(args.newEmail).toBe(newEmail.toLowerCase());
    expect(args.previousEmail).toBe(oldEmail.toLowerCase());
    expect(args.adminName).toBe("Robin Admin");
    expect(args.branding?.orgName).toBe(org.name);
    expect(args.branding?.orgId).toBe(org.id);
  });
});
