/**
 * Unit tests: `notifyHandlerAssigned` provider_unconfigured branch
 * (Task #1502, lib line 1611). Companion to the route-level coverage in
 * `data-request-handler-assigned.test.ts`, which mocks comms but never
 * exercises the email leg directly.
 *
 * The privacy-handler assignment fan-out has three legs:
 *   - in-app  → memberMessages row tagged
 *               `data_request_handler_assigned`
 *   - email   → `sendDataRequestHandlerAssignedEmail`
 *   - push    → `sendTransactionalPush` to the new handler's user id
 *
 * When the mailer throws an env-wide misconfiguration error
 * (e.g. `RESEND_API_KEY not set` / `SMTP host not configured`), the
 * helper must:
 *   1. Classify the error via `classifyMailerError === "provider_unconfigured"`
 *   2. Map it to terminal `emailStatus = "skipped"` /
 *      `emailError = "provider_not_configured"` (NOT `failed`) so the
 *      cron-side retry helper — which keys on
 *      `lastEmailStatus === "failed"` — never re-selects this dispatch
 *      and bills another N attempts for the same env issue.
 *   3. NOT emit the standard `[data-request-notify] Failed to send
 *      handler-assigned email` error log line (the silent-skip contract
 *      that keeps the on-call dashboard quiet during env misconfigs).
 *   4. Continue with in-app + push fan-out independently because the
 *      email failure is caught and isolated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendDataRequestHandlerAssignedEmailMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    }),
  ),
  sendDataRequestHandlerAssignedEmailMock: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => undefined,
  ),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => "wa-msg-id"),
}));

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendDataRequestHandlerAssignedEmail: sendDataRequestHandlerAssignedEmailMock,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
  type MemberDataRequest,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { notifyHandlerAssigned } from "../lib/dataRequestNotify.js";
import { logger } from "../lib/logger.js";

let testOrgId: number;
let testMemberId: number;
let memberUserId: number;
let handlerUserId: number;

const createdRequestIds: number[] = [];

async function insertFreshRequest(): Promise<MemberDataRequest> {
  const now = new Date();
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "in_progress",
    requestedAt: now,
    dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).returning();
  createdRequestIds.push(row.id);
  return row as MemberDataRequest;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HandlerProvUnconf_${ts}`,
    slug: `test-handler-prov-unconf-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [memberUser] = await db.insert(appUsersTable).values({
    replitUserId: `handler-prov-unconf-member-user-${ts}`,
    username: `handler_prov_unconf_member_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = memberUser.id;

  const [handlerUser] = await db.insert(appUsersTable).values({
    replitUserId: `handler-prov-unconf-handler-user-${ts}`,
    username: `handler_prov_unconf_handler_${ts}`,
    email: "handler@example.test",
    displayName: "Asha Handler",
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  handlerUserId = handlerUser.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Privacy",
    lastName: "Member",
    email: "member@example.test",
    userId: memberUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.relatedEntityId, id));
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, handlerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockClear();
  sendDataRequestHandlerAssignedEmailMock.mockClear();
});

describe("notifyHandlerAssigned — provider_unconfigured branch (Task #1502)", () => {
  it("maps mailer-not-configured to skipped/provider_not_configured; in-app + push still dispatch; no error log", async () => {
    sendDataRequestHandlerAssignedEmailMock.mockRejectedValueOnce(
      new Error("RESEND_API_KEY not set"),
    );
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      const request = await insertFreshRequest();

      const result = await notifyHandlerAssigned({
        request,
        newHandlerUserId: handlerUserId,
      });

      // Email leg: env-wide misconfig → terminal skipped, NOT failed.
      expect(result.emailStatus).toBe("skipped");
      expect(result.emailError).toBe("provider_not_configured");
      expect(sendDataRequestHandlerAssignedEmailMock).toHaveBeenCalledTimes(1);

      // In-app + push fan out independently of the email skip.
      expect(result.inAppMessageId).toBeTypeOf("number");
      expect(result.pushStatus).toBe("sent");
      expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
      const [pushRecipients, , , pushPayload] = sendTransactionalPushMock.mock.calls[0]! as [
        number[], string, string, Record<string, unknown>,
      ];
      expect(pushRecipients).toEqual([handlerUserId]);
      expect(pushPayload.type).toBe("data_request_assigned");
      expect(pushPayload.requestId).toBe(request.id);

      // Silent-skip contract: the standard `Failed to send handler-assigned
      // email` error line must NOT fire for the env-misconfig branch.
      const sendFailureLog = errorSpy.mock.calls.find(args => {
        const msg = (typeof args[1] === "string" ? args[1] : "");
        return msg.includes("Failed to send handler-assigned email");
      });
      expect(sendFailureLog).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
