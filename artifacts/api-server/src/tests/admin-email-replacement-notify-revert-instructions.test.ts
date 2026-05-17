/**
 * Task #1932 — End-to-end coverage for the "tell members how to revert
 * an unwanted admin email change" workflow.
 *
 * Surfaces under test:
 *   1. The in-app inbox row written by `notifyMemberOfAdminEmailReplacement`
 *      (artifacts/api-server/src/lib/adminEmailReplacementNotify.ts) leads
 *      with a one-click self-service deep link AND keeps the manual
 *      "contact your admin" fallback for members who'd rather pick up
 *      the phone, naming the actor admin and surfacing their reply-to
 *      email when one is on file.
 *   2. `GET  /api/marketing/email-change-dispute/:token` resolves the
 *      token, returns plain-language change details, and surfaces a
 *      `pending` status when nothing else has happened yet.
 *   3. `POST .../revert` atomically restores the previous address on
 *      the member's `app_users` row, writes an audit row whose metadata
 *      links back to the original `reenable_with_replacement` audit
 *      row id, and notifies every org admin via the inbox.
 *   4. `POST .../dispute` records a dispute audit row (no email change)
 *      that also links back to the original re-enable, and is
 *      idempotent — a second press is rejected as "already actioned".
 *   5. The token is rejected with `expired` when older than the TTL,
 *      and with `bad_signature` when tampered with.
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
  memberMessagesTable,
  emailSuppressionsTable,
  memberAuditLogTable,
} from "@workspace/db";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import { sendAccountEmailChangedByAdminEmail } from "../lib/mailer.js";
import {
  issueEmailChangeDisputeToken,
  EMAIL_CHANGE_DISPUTE_TOKEN_TTL_MS,
} from "../lib/email-change-dispute-token.js";

const emailMock = vi.mocked(sendAccountEmailChangedByAdminEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdSuppressionIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-admin-email-replacement-revert";
  }
});

async function makeOrg(label: string): Promise<{ id: number; name: string }> {
  const tag = uid(label);
  const name = `T1932_${tag}`;
  const [o] = await db.insert(organizationsTable).values({
    name,
    slug: `t1932-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return { id: o.id, name };
}

async function makeAdmin(orgId: number, displayName: string, opts?: { withEmail?: boolean }): Promise<TestUser & { email: string | null; clubMemberId?: number }> {
  const tag = uid("admin");
  const email = opts?.withEmail === false ? null : `${tag}@admins.test.local`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: email ?? `${tag}@placeholder.local`,
    displayName,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: u.id,
    role: "org_admin",
  });
  // Anchor a club_members row so the dispute fan-out can drop an inbox
  // entry to this admin (notifications are routed via club_members).
  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: u.id,
    firstName: displayName.split(" ")[0] ?? "Admin",
    lastName: displayName.split(" ").slice(1).join(" ") || "User",
    email: email ?? `${tag}@placeholder.local`,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(cm.id);
  return {
    id: u.id,
    username: tag,
    displayName,
    role: "org_admin",
    organizationId: orgId,
    email,
    clubMemberId: cm.id,
  };
}

async function makeMember(
  orgId: number,
  email: string,
): Promise<{ userId: number; clubMemberId: number }> {
  const tag = uid("member");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email,
    displayName: "Member Under Test",
    role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: u.id,
    role: "player",
  });
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: u.id,
    firstName: "Member",
    lastName: "UnderTest",
    email,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return { userId: u.id, clubMemberId: m.id };
}

async function makeSuppression(orgId: number, email: string): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    reason: "bounced",
    bounceType: "BadMailbox",
    description: "test fixture: mailbox does not exist",
  }).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));

  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  if (createdOrgIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.organizationId, createdOrgIds));
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
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
  emailMock.mockResolvedValue(undefined as unknown as void);
});

async function fetchInbox(orgId: number, clubMemberId: number) {
  return db
    .select()
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.clubMemberId, clubMemberId),
      eq(memberMessagesTable.relatedEntity, "account_email_changed_by_admin"),
    ));
}

const REENABLE_URL = (orgId: number, supId: number) =>
  `/api/organizations/${orgId}/marketing/suppressions/${supId}/reenable`;

/** Extract the dispute deep-link token from the inbox body. */
function extractTokenFromBody(body: string): string {
  const m = body.match(/email-change-dispute\/([A-Za-z0-9._\-%]+)/);
  if (!m) throw new Error(`Body did not contain a dispute deep link:\n${body}`);
  return decodeURIComponent(m[1]);
}

describe("Task #1932 — admin email-replacement: in-app notice + self-service dispute / revert", () => {
  it("in-app body leads with a one-click revert deep link and keeps the manual fallback (admin has email on file)", async () => {
    const org = await makeOrg("revert_full");
    const admin = await makeAdmin(org.id, "Pat Admin");
    const oldEmail = `bounced-${uid("o")}@example.com`;
    const newEmail = `corrected-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);
    const supId = await makeSuppression(org.id, oldEmail);

    const app = createTestApp(admin as unknown as TestUser);
    const resp = await request(app)
      .post(REENABLE_URL(org.id, supId))
      .send({ replacementEmail: newEmail, confirmed: true });
    expect(resp.status).toBe(200);
    expect(resp.body.updatedUserIds).toContain(member.userId);

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    expect(inbox.length).toBe(1);
    const body = inbox[0].body;

    // The one-click revert option leads.
    expect(body).toContain("you have two ways to fix it:");
    expect(body).toMatch(/One-click revert \(recommended\): open https?:\/\/[^\s]+\/portal\/email-change-dispute\//);
    expect(body).toContain("expires in 30 days");

    // The manual path is kept as the second option, naming the actor and
    // surfacing their reply-to email.
    expect(body).toContain("Pat Admin");
    expect(body).toContain(`Reply directly to Pat Admin at ${admin.email}`);
    expect(body).toContain(`set your contact email back to ${oldEmail.toLowerCase()} (or to a working address you control)`);
    expect(body).toContain(`any other admin at ${org.name}`);
    expect(body).toMatch(/sign in with that address and reset your password/i);
  });

  it("falls back to the original manual-only copy when no audit id is available (defence-in-depth: helper degrades cleanly)", async () => {
    // Drive the helper directly with originalAuditId omitted to prove
    // the fallback branch still renders the actionable manual steps.
    const { notifyMemberOfAdminEmailReplacement } = await import("../lib/adminEmailReplacementNotify.js");
    const org = await makeOrg("fallback_no_audit");
    const admin = await makeAdmin(org.id, "Sam Admin", { withEmail: false });
    const oldEmail = `noemail-${uid("o")}@example.com`;
    const newEmail = `noemail-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);

    await notifyMemberOfAdminEmailReplacement({
      organizationId: org.id,
      affectedUserId: member.userId,
      actor: { id: admin.id, displayName: admin.displayName, email: null },
      previousEmail: oldEmail,
      newEmail,
      // originalAuditId intentionally omitted
    });

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    expect(inbox.length).toBe(1);
    const body = inbox[0].body;
    // No deep link rendered — fallback branch.
    expect(body).not.toContain("/portal/email-change-dispute/");
    expect(body).toContain("here's how to revert it:");
    // Degrades cleanly when actor has no email on file.
    expect(body).not.toContain("Reply directly to");
    expect(body).toContain("Reach out to Sam Admin (the admin who made the change)");
    expect(body).toContain(`set your contact email back to ${oldEmail.toLowerCase()}`);
    expect(body).toContain(`contact any other admin at ${org.name}`);
  });

  it("GET dispute returns pending status with plain-language details", async () => {
    const org = await makeOrg("dispute_get");
    const admin = await makeAdmin(org.id, "Riley Admin");
    const oldEmail = `g-${uid("o")}@example.com`;
    const newEmail = `g-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);
    const supId = await makeSuppression(org.id, oldEmail);

    const app = createTestApp(admin as unknown as TestUser);
    const reenableResp = await request(app)
      .post(REENABLE_URL(org.id, supId))
      .send({ replacementEmail: newEmail, confirmed: true });
    expect(reenableResp.status).toBe(200);

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    const token = extractTokenFromBody(inbox[0].body);

    const getResp = await request(app).get(`/api/marketing/email-change-dispute/${encodeURIComponent(token)}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.ok).toBe(true);
    expect(getResp.body.status).toBe("pending");
    expect(getResp.body.canRevert).toBe(true);
    expect(getResp.body.info.orgName).toBe(org.name);
    expect(getResp.body.info.adminName).toBe("Riley Admin");
    expect(getResp.body.info.adminEmail).toBe(admin.email);
    expect(getResp.body.info.previousEmail.toLowerCase()).toBe(oldEmail.toLowerCase());
    expect(getResp.body.info.newEmail.toLowerCase()).toBe(newEmail.toLowerCase());
  });

  it("POST .../revert restores the previous email, writes a linked audit row, and notifies every admin", async () => {
    const org = await makeOrg("revert_action");
    const admin = await makeAdmin(org.id, "Casey Admin");
    const otherAdmin = await makeAdmin(org.id, "Jordan SecondAdmin");
    const oldEmail = `r-${uid("o")}@example.com`;
    const newEmail = `r-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);
    const supId = await makeSuppression(org.id, oldEmail);

    const app = createTestApp(admin as unknown as TestUser);
    await request(app)
      .post(REENABLE_URL(org.id, supId))
      .send({ replacementEmail: newEmail, confirmed: true })
      .expect(200);

    const [originalAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, org.id),
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.action, "reenable_with_replacement"),
      ));
    expect(originalAudit).toBeDefined();

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    const token = extractTokenFromBody(inbox[0].body);

    // The user's app_users row was rewritten to the new email; sanity-check.
    const [userBefore] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, member.userId));
    expect(userBefore.email?.toLowerCase()).toBe(newEmail.toLowerCase());

    const revertResp = await request(app)
      .post(`/api/marketing/email-change-dispute/${encodeURIComponent(token)}/revert`)
      .send({});
    expect(revertResp.status).toBe(200);
    expect(revertResp.body.ok).toBe(true);
    expect(revertResp.body.action).toBe("reverted");
    expect(revertResp.body.restoredEmail.toLowerCase()).toBe(oldEmail.toLowerCase());
    expect(revertResp.body.originalAuditId).toBe(originalAudit.id);

    // Email is back on the user row.
    const [userAfter] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, member.userId));
    expect(userAfter.email?.toLowerCase()).toBe(oldEmail.toLowerCase());

    // Audit row exists, links to the original audit row by id, and is
    // anchored to the affected member so Member 360 picks it up.
    const [revertAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, org.id),
        eq(memberAuditLogTable.action, "email_change_reverted_by_member"),
      ));
    expect(revertAudit).toBeDefined();
    expect(revertAudit.entity).toBe("email_suppression");
    expect(revertAudit.clubMemberId).toBe(member.clubMemberId);
    expect((revertAudit.metadata as Record<string, unknown>).originalAuditId).toBe(originalAudit.id);
    expect((revertAudit.metadata as Record<string, unknown>).source).toBe("self_service_dispute_link");

    // Both admins (the original actor + a peer) got an inbox notice.
    const adminInbox = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, org.id),
        eq(memberMessagesTable.relatedEntity, "email_change_reverted_by_member"),
      ));
    const notifiedClubMemberIds = adminInbox.map((r) => r.clubMemberId).sort();
    expect(notifiedClubMemberIds).toEqual([admin.clubMemberId, otherAdmin.clubMemberId].sort());
    expect(adminInbox[0].body).toContain(`#${originalAudit.id}`);
  });

  it("POST .../dispute records a dispute audit row without changing the email and is idempotent on a second press", async () => {
    const org = await makeOrg("dispute_action");
    const admin = await makeAdmin(org.id, "Morgan Admin");
    const oldEmail = `d-${uid("o")}@example.com`;
    const newEmail = `d-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);
    const supId = await makeSuppression(org.id, oldEmail);

    const app = createTestApp(admin as unknown as TestUser);
    await request(app)
      .post(REENABLE_URL(org.id, supId))
      .send({ replacementEmail: newEmail, confirmed: true })
      .expect(200);

    const [originalAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, org.id),
        eq(memberAuditLogTable.action, "reenable_with_replacement"),
      ));

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    const token = extractTokenFromBody(inbox[0].body);

    const disputeResp = await request(app)
      .post(`/api/marketing/email-change-dispute/${encodeURIComponent(token)}/dispute`)
      .send({});
    expect(disputeResp.status).toBe(200);
    expect(disputeResp.body.ok).toBe(true);
    expect(disputeResp.body.action).toBe("dispute_recorded");

    // Email is unchanged (dispute notifies admins; it does NOT clobber).
    const [userAfter] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, member.userId));
    expect(userAfter.email?.toLowerCase()).toBe(newEmail.toLowerCase());

    const [disputeAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, org.id),
        eq(memberAuditLogTable.action, "email_change_disputed"),
      ));
    expect(disputeAudit).toBeDefined();
    expect((disputeAudit.metadata as Record<string, unknown>).originalAuditId).toBe(originalAudit.id);

    // Second press is rejected.
    const second = await request(app)
      .post(`/api/marketing/email-change-dispute/${encodeURIComponent(token)}/dispute`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("already_actioned");

    // And revert is now also blocked because the change has been actioned.
    const revertAfter = await request(app)
      .post(`/api/marketing/email-change-dispute/${encodeURIComponent(token)}/revert`)
      .send({});
    expect(revertAfter.status).toBe(409);
    expect(revertAfter.body.code).toBe("already_actioned");
  });

  it("rejects expired and tampered tokens with the correct codes", async () => {
    const org = await makeOrg("expired_tampered");
    const admin = await makeAdmin(org.id, "Avery Admin");
    const oldEmail = `e-${uid("o")}@example.com`;
    const newEmail = `e-${uid("n")}@example.com`;
    const member = await makeMember(org.id, oldEmail);
    const supId = await makeSuppression(org.id, oldEmail);

    const app = createTestApp(admin as unknown as TestUser);
    await request(app)
      .post(REENABLE_URL(org.id, supId))
      .send({ replacementEmail: newEmail, confirmed: true })
      .expect(200);

    const inbox = await fetchInbox(org.id, member.clubMemberId);
    const validToken = extractTokenFromBody(inbox[0].body);

    // Tamper with the signature half.
    const dot = validToken.indexOf(".");
    const tampered = `${validToken.slice(0, dot)}.${"f".repeat(64)}`;
    const badResp = await request(app).get(`/api/marketing/email-change-dispute/${encodeURIComponent(tampered)}`);
    expect(badResp.status).toBe(400);
    expect(badResp.body.code).toBe("bad_signature");

    // Issue an artificially old token by hand-rolling it via the issuer
    // helper, then time-travel by patching iat in the payload directly.
    // Simpler: issue a fresh one and prove the verifier rejects an iat
    // older than the TTL by re-encoding.
    const expiredToken = (() => {
      // Decode -> mutate iat -> re-sign: but we only export the issuer.
      // Use the issuer plus a pre-stale Date.now() override.
      const now = Date.now;
      try {
        Date.now = () => now() - EMAIL_CHANGE_DISPUTE_TOKEN_TTL_MS - 60_000;
        return issueEmailChangeDisputeToken({
          o: org.id,
          u: member.userId,
          a: 1,
          p: oldEmail,
          n: newEmail,
        });
      } finally {
        Date.now = now;
      }
    })();
    const expiredResp = await request(app).get(`/api/marketing/email-change-dispute/${encodeURIComponent(expiredToken)}`);
    expect(expiredResp.status).toBe(410);
    expect(expiredResp.body.code).toBe("expired");
  });
});
