/**
 * Integration tests: Privacy email-exhaustion admin alert (Task 238).
 *
 * `notifyAdminsOfEmailRetryExhaustion` is the regulatory alert raised when a
 * mandatory privacy notice email gives up after the per-request retry cap.
 * Regressions here would silently swallow a regulatory alert, so this suite
 * locks in:
 *
 *   1. Dedup — a second call for the same request no-ops via the
 *      `emailExhaustionNotifiedAt` stamp.
 *   2. Recipient union — direct `app_users.role='org_admin'` for the org,
 *      plus `org_memberships` with `org_admin`/`competition_secretary` roles,
 *      plus the assigned `handlerUserId`, are all unioned (and deduped) into
 *      the push call.
 *   3. In-app message tagged — the inserted `member_messages` row carries
 *      `relatedEntity='data_request_email_exhausted'` so it groups with the
 *      affected request on Member 360.
 *   4. Reset — a fresh `notifyDataRequest` clears `emailExhaustionNotifiedAt`
 *      so a future exhaustion of *that* notice can re-alert admins.
 *
 * `comms` and `mailer` are mocked so push/email calls are observable side-effects
 * rather than real network calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendTransactionalSmsMock, sendDataRequestEmailMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendTransactionalSmsMock: vi.fn(async () => undefined),
  sendDataRequestEmailMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
}));
vi.mock("../lib/mailer.js", async (importOriginal) => {
  // Preserve `classifyMailerError` (Task #1279) and other real exports so the
  // hard-bounce shortcut in `dataRequestNotify` keeps working under the mock.
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendDataRequestEmail: sendDataRequestEmailMock,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
  type MemberDataRequest,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  notifyAdminsOfEmailRetryExhaustion,
  notifyDataRequest,
  DATA_REQUEST_MAX_EMAIL_ATTEMPTS,
} from "../lib/dataRequestNotify.js";

// The privacy/comm tables this suite touches (member_messages,
// member_data_requests, member_comm_prefs, org_memberships.vendor_operator_id)
// are part of the standard Drizzle schema. Keeping the test DB in sync with
// `lib/db/src/schema/golf.ts` via `pnpm --filter @workspace/db push-force`
// is the responsibility of the post-merge / dev-bootstrap flow — see
// `docs/db-test-sync.md`.

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let otherOrgId: number;
let testMemberId: number;
let directAdminId: number;
let membershipAdminId: number;
let membershipSecretaryId: number;
let handlerUserId: number;
let outsiderUserId: number;
let nonAdminMemberId: number;

const createdRequestIds: number[] = [];

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PrivacyExhaust_${ts}`,
    slug: `test-privacy-exhaust-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `OtherOrg_PrivacyExhaust_${ts}`,
    slug: `other-privacy-exhaust-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  // Member the privacy request belongs to
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Test",
    lastName: "Member",
    email: "exhaust-member@example.test",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  // 1. Direct admin: app_users.role = "org_admin", organizationId = testOrgId
  const [directAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `direct-admin-${ts}`,
    username: `direct_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  directAdminId = directAdmin.id;

  // 2. Membership admin: app_users.role = "player" but a row in
  //    org_memberships with role = "org_admin" for this org.
  const [membershipAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `membership-admin-${ts}`,
    username: `membership_admin_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipAdminId = membershipAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipAdminId,
    role: "org_admin",
  });

  // 3. Membership competition_secretary
  const [membershipSec] = await db.insert(appUsersTable).values({
    replitUserId: `membership-secretary-${ts}`,
    username: `membership_secretary_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipSecretaryId = membershipSec.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipSecretaryId,
    role: "competition_secretary",
  });

  // 4. Assigned handler — distinct app_user, not otherwise an admin
  const [handler] = await db.insert(appUsersTable).values({
    replitUserId: `handler-${ts}`,
    username: `handler_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  handlerUserId = handler.id;

  // 5. A different-org admin who must NOT be included
  const [outsider] = await db.insert(appUsersTable).values({
    replitUserId: `outsider-admin-${ts}`,
    username: `outsider_admin_${ts}`,
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsider.id;

  // 6. A "player" with an org_membership that is NOT admin/secretary —
  //    must NOT be included.
  const [nonAdminMember] = await db.insert(appUsersTable).values({
    replitUserId: `nonadmin-member-${ts}`,
    username: `nonadmin_member_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  nonAdminMemberId = nonAdminMember.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: nonAdminMemberId,
    role: "player",
  });
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const uid of [directAdminId, membershipAdminId, membershipSecretaryId, handlerUserId, outsiderUserId, nonAdminMemberId]) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendDataRequestEmailMock.mockClear();
});

// Helper: insert a fresh privacy request whose email is in the "failed" /
// exhausted state, ready to be alerted on.
async function insertExhaustedRequest(overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {}): Promise<MemberDataRequest> {
  const now = new Date();
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "in_progress",
    requestedAt: now,
    dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    lastNotificationKind: "filed",
    lastNotifiedAt: now,
    lastEmailStatus: "failed",
    lastEmailAt: now,
    lastEmailError: "smtp 550 mailbox unavailable",
    emailAttempts: 5,
    lastEmailRetryAt: now,
    emailRetryExhaustedAt: now,
    ...overrides,
  }).returning();
  createdRequestIds.push(row.id);
  return row as MemberDataRequest;
}

// ── 1. Dedup ──────────────────────────────────────────────────────────────

describe("notifyAdminsOfEmailRetryExhaustion — dedup", () => {
  it("a second call for the same request is a no-op", async () => {
    const request = await insertExhaustedRequest();

    const first = await notifyAdminsOfEmailRetryExhaustion({ request });
    expect(first.notified).toBe(true);
    expect(first.recipients).toBeGreaterThan(0);

    // Re-load the row to pick up the stamp the helper just wrote.
    const [reloaded] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.emailExhaustionNotifiedAt).not.toBeNull();

    sendTransactionalPushMock.mockClear();

    const second = await notifyAdminsOfEmailRetryExhaustion({ request: reloaded as MemberDataRequest });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);
    // No second push fan-out either.
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    // Only one in-app exhaustion message exists for this request.
    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_email_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
  });
});

// ── 2. Recipients union ───────────────────────────────────────────────────

describe("notifyAdminsOfEmailRetryExhaustion — recipients union", () => {
  it("unions direct org_admin app_users + org_memberships admins/secretaries + handler, dedup-ed", async () => {
    const request = await insertExhaustedRequest({ handlerUserId });

    const result = await notifyAdminsOfEmailRetryExhaustion({ request });
    expect(result.notified).toBe(true);
    // 4 distinct recipients: direct admin, membership admin, membership
    // secretary, handler. Outsider-org admin and non-admin membership user
    // must be excluded.
    expect(result.recipients).toBe(4);

    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients] = sendTransactionalPushMock.mock.calls[0]! as [number[], string, string, Record<string, unknown>];
    const recipientSet = new Set(recipients);
    expect(recipientSet.size).toBe(recipients.length); // no duplicates
    expect(recipientSet.has(directAdminId)).toBe(true);
    expect(recipientSet.has(membershipAdminId)).toBe(true);
    expect(recipientSet.has(membershipSecretaryId)).toBe(true);
    expect(recipientSet.has(handlerUserId)).toBe(true);
    expect(recipientSet.has(outsiderUserId)).toBe(false);
    expect(recipientSet.has(nonAdminMemberId)).toBe(false);
  });

  it("does not double-count when handler is already an admin", async () => {
    // Handler is the direct admin → set should still be 3 distinct recipients.
    const request = await insertExhaustedRequest({ handlerUserId: directAdminId });

    const result = await notifyAdminsOfEmailRetryExhaustion({ request });
    expect(result.notified).toBe(true);
    expect(result.recipients).toBe(3);

    const [recipients] = sendTransactionalPushMock.mock.calls[0]! as [number[], string, string, Record<string, unknown>];
    expect(new Set(recipients).size).toBe(3);
  });
});

// ── 3. In-app message tagged ──────────────────────────────────────────────

describe("notifyAdminsOfEmailRetryExhaustion — in-app message", () => {
  it("inserts a member_messages row tagged with the data_request_email_exhausted relation", async () => {
    const request = await insertExhaustedRequest();

    await notifyAdminsOfEmailRetryExhaustion({ request });

    const [msg] = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_email_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));

    expect(msg).toBeDefined();
    expect(msg.organizationId).toBe(testOrgId);
    expect(msg.clubMemberId).toBe(testMemberId);
    expect(msg.channel).toBe("in_app");
    expect(msg.status).toBe("sent");
    expect(msg.senderUserId).toBeNull();
    // Subject/body should reference the request id so admins can navigate.
    expect(msg.subject).toContain(`#${request.id}`);
    expect(msg.body).toContain(`#${request.id}`);
  });
});

// ── 4. Task #1279 — hard SMTP bounce on first attempt short-circuits ──────

describe("notifyDataRequest — Task #1279 hard bounce shortcut", () => {
  it("hard SMTP 550 on the first email attempt jumps straight to exhausted (no retries scheduled) and fires the admin alert", async () => {
    // Fresh privacy request, NOT yet in the exhausted state — the initial
    // send will be the first email attempt for this row.
    const [request] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "received",
      requestedAt: new Date(),
      dueBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(request.id);

    // Provider rejects with a hard SMTP bounce on the very first attempt.
    sendDataRequestEmailMock.mockRejectedValueOnce(
      new Error("550 5.1.1 The email account that you tried to reach does not exist"),
    );
    sendTransactionalPushMock.mockClear();

    await notifyDataRequest({
      organizationId: testOrgId,
      request: request as MemberDataRequest,
      kind: "filed",
    });

    const [row] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));

    // Cap reached on the very first attempt — cron can never re-pick this row.
    expect(row.lastEmailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(DATA_REQUEST_MAX_EMAIL_ATTEMPTS);
    expect(row.emailRetryExhaustedAt).not.toBeNull();
    // The single provider call was the initial send — no extra retries fired.
    expect(sendDataRequestEmailMock).toHaveBeenCalledTimes(1);
    // The admin exhaustion alert fanned out exactly once.
    expect(row.emailExhaustionNotifiedAt).not.toBeNull();
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
  });

  it("transient SMTP failure (timeout) on the first attempt still uses the normal retry path", async () => {
    // Sanity check: the bounce classifier must NOT trip on a transient
    // error message — otherwise the existing 5-retry pipeline collapses.
    const [request] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "received",
      requestedAt: new Date(),
      dueBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(request.id);

    sendDataRequestEmailMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    sendTransactionalPushMock.mockClear();

    await notifyDataRequest({
      organizationId: testOrgId,
      request: request as MemberDataRequest,
      kind: "filed",
    });

    const [row] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));

    expect(row.lastEmailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1); // NOT short-circuited
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.emailExhaustionNotifiedAt).toBeNull();
  });
});

// ── 5. Reset on a fresh notifyDataRequest ─────────────────────────────────

describe("notifyAdminsOfEmailRetryExhaustion — reset on fresh notification", () => {
  it("clears emailExhaustionNotifiedAt so a future exhaustion can re-alert", async () => {
    const request = await insertExhaustedRequest();

    // Stamp the dedup field via the alert helper.
    await notifyAdminsOfEmailRetryExhaustion({ request });
    const [stamped] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.emailExhaustionNotifiedAt).not.toBeNull();

    // A fresh privacy notification should reset the dedup stamp.
    await notifyDataRequest({
      organizationId: testOrgId,
      request: stamped as MemberDataRequest,
      kind: "in_progress",
    });

    const [afterFresh] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(afterFresh.emailExhaustionNotifiedAt).toBeNull();

    // And a follow-up exhaustion alert is once again allowed.
    sendTransactionalPushMock.mockClear();
    const replay = await notifyAdminsOfEmailRetryExhaustion({ request: afterFresh as MemberDataRequest });
    expect(replay.notified).toBe(true);
    expect(replay.recipients).toBeGreaterThan(0);
  });
});
