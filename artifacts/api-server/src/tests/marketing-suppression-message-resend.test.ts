/**
 * Integration tests: POST /organizations/:orgId/marketing/suppressions/:id/message/resend
 *
 * Task #1936 — "Let admins resend a fixed message after re-enabling a bounced
 * address". Covers:
 *   - auth/admin/org-scoping guards
 *   - 400 on missing / malformed `to`
 *   - 409 (`still_suppressed`) when the suppression is still active and the
 *     destination matches the bounced recipient
 *   - 409 (`target_suppressed`) when the destination is itself on the
 *     suppression list (different row)
 *   - 409 / 404 when the suppression has no MessageID or doesn't exist
 *   - 404 (`message_not_available`) when Postmark has aged out the body
 *   - 502 (`send_failed`) when the provider rejects the resend
 *   - happy paths: replacement-email resend (suppression still active) and
 *     post-reenable resend recovered from the audit trail
 *   - audit row written with `resend_bounced_message`, threaded to the
 *     linked club_member when one exists
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  memberAuditLogTable,
  clubMembersTable,
} from "@workspace/db";
import { and, eq, inArray, desc } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsiderUserId: number;
let admin: TestUser;
let outsider: TestUser;

const createdSuppressionIds: number[] = [];
const createdMemberIds: number[] = [];

async function makeSuppression(opts: {
  orgId: number;
  email: string;
  messageId?: string | null;
  reason?: string;
  bounceType?: string | null;
}): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "HardBounce",
    messageId: opts.messageId ?? null,
    description: "Recipient mailbox does not exist",
  }).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

async function makeMember(opts: { orgId: number; email: string; firstName?: string; lastName?: string }): Promise<number> {
  const [row] = await db.insert(clubMembersTable).values({
    organizationId: opts.orgId,
    firstName: opts.firstName ?? "First",
    lastName: opts.lastName ?? "Last",
    email: opts.email,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(row.id);
  return row.id;
}

async function clearAudits() {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "email_suppression"),
    inArray(memberAuditLogTable.organizationId, [orgAId, orgBId].filter(Boolean) as number[]),
  ));
}

beforeAll(async () => {
  const stamp = uid("resend");
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_Resend_A_${stamp}`,
    slug: `test-resend-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_Resend_B_${stamp}`,
    slug: `test-resend-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `resend-admin-${stamp}`,
    username: `resend_admin_${stamp}`,
    email: `resend_admin_${stamp}@example.com`,
    displayName: "Resend Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsiderRow] = await db.insert(appUsersTable).values({
    replitUserId: `resend-outsider-${stamp}`,
    username: `resend_outsider_${stamp}`,
    email: `resend_outsider_${stamp}@example.com`,
    displayName: "Resend Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsiderRow.id;

  admin = {
    id: adminUserId,
    username: `resend_admin_${stamp}`,
    displayName: "Resend Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsiderUserId,
    username: `resend_outsider_${stamp}`,
    displayName: "Resend Outsider",
    role: "player",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearAudits();
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, [adminUserId, outsiderUserId].filter(Boolean) as number[]));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (outsiderUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearAudits();
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
    createdSuppressionIds.length = 0;
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
    createdMemberIds.length = 0;
  }
});

const URL = (orgId: number, supId: number) =>
  `/api/organizations/${orgId}/marketing/suppressions/${supId}/message/resend`;

const FAKE_MESSAGE_ID = "abcd1234-5678-90ab-cdef-1234567890ab";

/**
 * Build a fetch double that:
 *   1. Returns a canned Postmark message-details payload for the GET to
 *      `/messages/outbound/<id>/details`.
 *   2. Returns a successful Postmark send response for the POST to
 *      `/email`.
 * Records the bodies of all requests so individual tests can assert what
 * we actually forwarded to Postmark.
 */
function makePostmarkFetchMock(opts?: {
  detailsHtml?: string | null;
  detailsText?: string | null;
  detailsSubject?: string;
  detailsFrom?: string;
  detailsTag?: string | null;
  detailsMetadata?: Record<string, string> | null;
  detailsStatus?: number;
  detailsBody?: unknown;
  sendStatus?: number;
  sendBody?: unknown;
}) {
  const sentRequests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    sentRequests.push({ url: u, init });
    if (u.includes("/messages/outbound/")) {
      if (opts?.detailsStatus && opts.detailsStatus !== 200) {
        return new Response(JSON.stringify(opts.detailsBody ?? { ErrorCode: 701, Message: "Message not found." }), {
          status: opts.detailsStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        MessageID: FAKE_MESSAGE_ID,
        To: [{ Email: "original@example.com" }],
        From: opts?.detailsFrom ?? "noreply@kharagolf.com",
        Subject: opts?.detailsSubject ?? "Hello from KHARAGOLF",
        HtmlBody: opts?.detailsHtml === undefined ? "<p>Hi there</p>" : opts.detailsHtml,
        TextBody: opts?.detailsText === undefined ? "Hi there" : opts.detailsText,
        Status: "Bounced",
        ReceivedAt: "2026-04-29T12:00:00Z",
        Tag: opts?.detailsTag === undefined ? "dues_receipt" : opts.detailsTag,
        Metadata: opts?.detailsMetadata === undefined ? { orgId: "999", flow: "dues_receipt" } : opts.detailsMetadata,
        Recipients: ["original@example.com"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/email")) {
      if (opts?.sendStatus && opts.sendStatus !== 200) {
        return new Response(JSON.stringify(opts.sendBody ?? { ErrorCode: 405, Message: "InactiveRecipient" }), {
          status: opts.sendStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ErrorCode: 0,
        Message: "OK",
        MessageID: "resent-msg-id-001",
        SubmittedAt: "2026-04-30T08:00:00Z",
        To: "destination@example.com",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not mocked", { status: 500 });
  });
  return { fn, sentRequests };
}

describe("POST /suppressions/:id/message/resend — auth & validation", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(outsider);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(403);
  });

  it("rejects admins from a different org with 403", async () => {
    const wrongOrgAdmin: TestUser = { ...admin, organizationId: orgBId };
    const app = createTestApp(wrongOrgAdmin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the suppression belongs to a different org and has no audit row in this org", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgBId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(404);
  });

  it("rejects missing `to` with 400", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to is required/);
  });

  it("rejects malformed `to` with 400", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/);
  });

  it("returns 409 (no_message_id) when the suppression has no Postmark MessageID", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `legacy-${uid()}@example.com`, messageId: null });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_message_id");
  });

  it.each([
    ["unsubscribed"],
    ["spam_complaint"],
    ["manual"],
  ])("rejects resend on non-bounce reason %s with 409", async (reason) => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({
      orgId: orgAId,
      email: `nb-${reason}-${uid()}@example.com`,
      reason,
      bounceType: null,
      messageId: FAKE_MESSAGE_ID,
    });
    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fixed@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe(reason);
  });
});

describe("POST /suppressions/:id/message/resend — Postmark wiring", () => {
  let originalToken: string | undefined;
  let originalProvider: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalToken = process.env.POSTMARK_SERVER_TOKEN;
    originalProvider = process.env.EMAIL_PROVIDER;
    originalFetch = globalThis.fetch;
    process.env.POSTMARK_SERVER_TOKEN = "test-token-resend";
    process.env.EMAIL_PROVIDER = "postmark";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = originalToken;
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects resend to the same address while the suppression is still active (still_suppressed)", async () => {
    const app = createTestApp(admin);
    const email = `still-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email, messageId: FAKE_MESSAGE_ID });

    const { fn } = makePostmarkFetchMock();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const res = await request(app).post(URL(orgAId, supId)).send({ to: email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("still_suppressed");
    // Postmark must NOT have been touched at all when the gate fires.
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects resend to another already-suppressed address (target_suppressed)", async () => {
    const app = createTestApp(admin);
    const email = `orig-${uid()}@example.com`;
    const otherEmail = `other-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email, messageId: FAKE_MESSAGE_ID });
    const conflictId = await makeSuppression({ orgId: orgAId, email: otherEmail, messageId: null });

    const { fn } = makePostmarkFetchMock();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const res = await request(app).post(URL(orgAId, supId)).send({ to: otherEmail });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("target_suppressed");
    expect(res.body.conflictId).toBe(conflictId);
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates Postmark 404 (aged-out body) as 404 with message_not_available", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `aged-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const { fn } = makePostmarkFetchMock({ detailsStatus: 404 });
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const res = await request(app).post(URL(orgAId, supId)).send({ to: "fresh@example.com" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("message_not_available");
    expect(res.body.messageId).toBe(FAKE_MESSAGE_ID);
  });

  it("returns 502 (send_failed) when the active provider rejects the resend", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const { fn } = makePostmarkFetchMock({
      sendStatus: 422,
      sendBody: { ErrorCode: 405, Message: "InactiveRecipient" },
    });
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const res = await request(app).post(URL(orgAId, supId)).send({ to: "destination@example.com" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("send_failed");
    expect(res.body.message).toMatch(/InactiveRecipient/);

    // No audit row should be written when the send actually failed.
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, supId),
        eq(memberAuditLogTable.action, "resend_bounced_message"),
      ));
    expect(audits.length).toBe(0);
  });

  it("happy path: resends to a corrected address while the suppression is still active and writes an audit row", async () => {
    const app = createTestApp(admin);
    const oldEmail = `typo-${uid()}@exmaple.com`;
    const newEmail = `typo-${uid()}@example.com`;
    const memberId = await makeMember({ orgId: orgAId, email: oldEmail, firstName: "Pat", lastName: "Typo" });
    const supId = await makeSuppression({ orgId: orgAId, email: oldEmail, messageId: FAKE_MESSAGE_ID });

    const { fn, sentRequests } = makePostmarkFetchMock();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const res = await request(app).post(URL(orgAId, supId)).send({ to: newEmail });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resentTo).toBe(newEmail.toLowerCase());
    expect(res.body.provider).toBe("postmark");
    expect(res.body.originalMessageId).toBe(FAKE_MESSAGE_ID);
    expect(res.body.messageId).toBe("resent-msg-id-001");

    // Two HTTP calls: GET details, then POST email.
    expect(fn).toHaveBeenCalledTimes(2);
    const sendCall = sentRequests.find(r => r.url.endsWith("/email"));
    expect(sendCall).toBeDefined();
    const sendBody = JSON.parse(String(sendCall!.init?.body ?? "{}"));
    expect(sendBody.To).toBe(newEmail.toLowerCase());
    expect(sendBody.Subject).toBe("Hello from KHARAGOLF");
    expect(sendBody.HtmlBody).toBe("<p>Hi there</p>");
    expect(sendBody.TextBody).toBe("Hi there");
    // Resend metadata stamps + carries forward original campaign/template tags.
    expect(sendBody.Metadata).toMatchObject({
      flow: "admin_message_resend",
      orgId: String(orgAId),
      resentFromMessageId: FAKE_MESSAGE_ID,
      resendActorUserId: String(adminUserId),
      originalRecipient: oldEmail.toLowerCase(),
    });
    // Tag from original message is preserved (Postmark uses single-tag).
    expect(sendBody.Tag).toBe("dues_receipt");

    // Suppression row is untouched — resend doesn't auto-clear.
    const [stillSup] = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(stillSup).toBeDefined();

    // Audit row threaded to the matched member.
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, supId),
        eq(memberAuditLogTable.action, "resend_bounced_message"),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(adminUserId);
    expect(audit.clubMemberId).toBe(memberId);
    const md = audit.metadata as Record<string, unknown> | null;
    expect(md).toBeTruthy();
    expect(md!.messageId).toBe(FAKE_MESSAGE_ID);
    expect(md!.resentTo).toBe(newEmail.toLowerCase());
    expect(md!.originalRecipient).toBe(oldEmail.toLowerCase());
    expect(md!.suppressionWasActive).toBe(true);
  });

  it("happy path: recovers the message id from the audit trail when the suppression has already been re-enabled", async () => {
    const app = createTestApp(admin);
    const oldEmail = `reenabled-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email: oldEmail, messageId: FAKE_MESSAGE_ID });

    // Simulate the /reenable code path: write the audit row, then delete
    // the suppression. This is exactly what /reenable does (transactional
    // delete + recordMemberAudit) so the resend route must still find a
    // way back to the original payload.
    await db.insert(memberAuditLogTable).values({
      organizationId: orgAId,
      clubMemberId: null,
      actorUserId: adminUserId,
      actorName: "Resend Admin",
      actorRole: "org_admin",
      entity: "email_suppression",
      entityId: supId,
      action: "reenable",
      reason: `Re-enabled ${oldEmail} after bounced (HardBounce)`,
      metadata: {
        suppressionReason: "bounced",
        bounceType: "HardBounce",
        description: "Recipient mailbox does not exist",
        messageId: FAKE_MESSAGE_ID,
        oldEmail,
      },
    });
    await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    // Don't try to clean it up in afterEach since it's already gone.
    const idx = createdSuppressionIds.indexOf(supId);
    if (idx >= 0) createdSuppressionIds.splice(idx, 1);

    const { fn, sentRequests } = makePostmarkFetchMock();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    // After re-enable, the destination CAN be the original (now-valid) address.
    const res = await request(app).post(URL(orgAId, supId)).send({ to: oldEmail });
    expect(res.status).toBe(200);
    expect(res.body.resentTo).toBe(oldEmail.toLowerCase());
    expect(res.body.originalMessageId).toBe(FAKE_MESSAGE_ID);

    const sendCall = sentRequests.find(r => r.url.endsWith("/email"));
    expect(sendCall).toBeDefined();
    const sendBody = JSON.parse(String(sendCall!.init?.body ?? "{}"));
    expect(sendBody.To).toBe(oldEmail.toLowerCase());

    // Audit row stamps suppressionWasActive=false (we recovered via audit).
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, supId),
        eq(memberAuditLogTable.action, "resend_bounced_message"),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit).toBeDefined();
    const md = audit.metadata as Record<string, unknown> | null;
    expect(md!.suppressionWasActive).toBe(false);
  });
});
