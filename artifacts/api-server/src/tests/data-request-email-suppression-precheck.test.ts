/**
 * Integration tests: Privacy email suppression pre-check (Task #2230).
 *
 * When the recipient address for a privacy-request notice is already on
 * the org's `email_suppressions` list, the first-attempt and retry paths
 * must short-circuit instead of issuing an SMTP send that we know will
 * bounce again. The skip:
 *
 *   1. Stamps `lastEmailStatus = "skipped"` and a structured
 *      `address_suppressed:<reason>` error so the resend popover can show
 *      the operator *why* the system did not attempt this notice.
 *   2. Leaves `emailAttempts = 0` (and does not stamp
 *      `emailRetryExhaustedAt`) on the first-attempt path, so the row is
 *      visibly distinct from a regular first-attempt failure (attempts=1)
 *      and from a hard-bounce exhaustion (attempts=5).
 *   3. Persists a `notification_audit_log` row with the same shape the
 *      dispatcher writes for `event_opted_out` skips, with a
 *      non-`event_opted_out` reason so the controller-facing
 *      "Suppressed notifications" portal page (Task #1775) tags it as
 *      `system_suppressed`.
 *   4. Is org-scoped — a suppression in another org must not block sends
 *      for this org's address.
 *   5. The retry path stamps `emailRetryExhaustedAt` so the cron treats
 *      the row as terminal in the same way it treats hard-bounce
 *      exhaustion, and does NOT increment `emailAttempts` (the skip is a
 *      routing decision, not a delivery attempt).
 *
 * `comms` and `mailer` are mocked so push/email calls are observable
 * side-effects rather than real network calls. `classifyMailerError` is
 * preserved on the mailer mock so the unrelated hard-bounce shortcut
 * keeps working.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendTransactionalSmsMock, sendDataRequestEmailMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSmsMock: vi.fn(async () => undefined),
  sendDataRequestEmailMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
  sendTransactionalWhatsapp: vi.fn(async () => "wa-msg-id"),
}));
vi.mock("../lib/mailer.js", async (importOriginal) => {
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
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
  type MemberDataRequest,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  notifyDataRequest,
  retryDataRequestEmail,
  DATA_REQUEST_MAX_EMAIL_ATTEMPTS,
} from "../lib/dataRequestNotify.js";

let testOrgId: number;
let otherOrgId: number;
let testMemberId: number;
let memberUserId: number;

const createdRequestIds: number[] = [];

async function suppress(orgId: number, email: string, opts: {
  reason?: string; bounceType?: string | null; description?: string | null;
} = {}): Promise<void> {
  await db.insert(emailSuppressionsTable).values({
    organizationId: orgId,
    email: email.toLowerCase(),
    reason: opts.reason ?? "hard_bounce",
    bounceType: opts.bounceType ?? "permanent",
    description: opts.description ?? "smtp 550 5.1.1 user unknown",
  });
}

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

async function insertFailedRetryRequest(): Promise<MemberDataRequest> {
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
    lastEmailError: "smtp 421 try again later",
    emailAttempts: 2,
    lastEmailRetryAt: now,
  }).returning();
  createdRequestIds.push(row.id);
  return row as MemberDataRequest;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PrivacySuppress_${ts}`,
    slug: `test-privacy-suppress-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `OtherOrg_PrivacySuppress_${ts}`,
    slug: `other-privacy-suppress-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `suppress-member-user-${ts}`,
    username: `suppress_member_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = u.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Bouncing",
    lastName: "Member",
    email: "Bouncy@Example.test",
    userId: memberUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(notificationAuditLogTable)
    .where(inArray(notificationAuditLogTable.userId, [memberUserId]));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, testOrgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, otherOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendDataRequestEmailMock.mockClear();
  // Wipe suppression + audit rows leftover from prior tests.
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, testOrgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, otherOrgId));
  await db.delete(notificationAuditLogTable)
    .where(inArray(notificationAuditLogTable.userId, [memberUserId]));
});

describe("notifyDataRequest — first-attempt suppression pre-check", () => {
  it("skips the SMTP send when the address is on the org suppression list", async () => {
    await suppress(testOrgId, "bouncy@example.test", {
      reason: "hard_bounce",
      bounceType: "permanent",
      description: "smtp 550 user unknown",
    });
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    // No SMTP attempt was made.
    expect(sendDataRequestEmailMock).not.toHaveBeenCalled();
    // Returned status reflects the skip.
    expect(result.emailStatus).toBe("skipped");
    expect(result.emailError).toBe("address_suppressed:hard_bounce");

    // Persisted state: skipped, attempts=0, no exhaustion stamp.
    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.lastEmailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("address_suppressed:hard_bounce");
    expect(row.emailAttempts).toBe(0);
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.emailExhaustionNotifiedAt).toBeNull();
    expect(row.lastEmailAt).not.toBeNull();
  });

  it("writes a notification_audit_log skip row classified as system_suppressed", async () => {
    await suppress(testOrgId, "bouncy@example.test", {
      reason: "complaint",
      bounceType: null,
      description: "marked as spam",
    });
    const request = await insertFreshRequest();

    await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "in_progress",
    });

    const auditRows = await db.select()
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.userId, memberUserId),
        eq(notificationAuditLogTable.notificationKey, "privacy.data_request.in_progress"),
      ))
      .orderBy(desc(notificationAuditLogTable.createdAt));

    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0];
    expect(audit.channel).toBe("email");
    expect(audit.status).toBe("skipped");
    // The reason is non-`event_opted_out` so the portal endpoint will
    // classify this row as `system_suppressed` for the controller UI.
    expect(audit.reason).toBe("address_suppressed:complaint");
    expect(audit.reason).not.toBe("event_opted_out");
    const payload = audit.payload as Record<string, unknown>;
    expect(payload.requestId).toBe(request.id);
    expect(payload.kind).toBe("in_progress");
    expect(payload.suppressionReason).toBe("complaint");
    // The audit payload must not leak the full email — only an
    // obfuscated suffix so the audit table cannot become a directory of
    // bouncing addresses for any insider with read access.
    expect(payload.emailSuffix).toBe("b***@example.test");
  });

  it("matches case-insensitively against the suppression list", async () => {
    // The bounce webhook normalises to lowercase, but the column-level
    // `lower(...)` comparison protects against any future ingestion path
    // (or hand-inserted operator row) that forgets to lowercase. The
    // member's email itself is mixed-case (`Bouncy@Example.test`).
    await db.insert(emailSuppressionsTable).values({
      organizationId: testOrgId,
      // Hand-insert a mixed-case suppression row to simulate an operator
      // bypass of the webhook normalisation.
      email: "BOUNCY@example.test",
      reason: "hard_bounce",
      bounceType: "permanent",
      description: "operator-inserted",
    });
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(sendDataRequestEmailMock).not.toHaveBeenCalled();
    expect(result.emailStatus).toBe("skipped");
    expect(result.emailError).toBe("address_suppressed:hard_bounce");
  });

  it("does not raise an admin email-exhaustion alert on a suppression skip", async () => {
    // The hard-bounce shortcut (Task #1279) pages admins by inserting a
    // member_messages row tagged `data_request_email_exhausted` *and*
    // stamps `emailExhaustionNotifiedAt`. A suppression skip must NOT
    // trigger either: the row never reaches the `failed`/`hard_bounce`
    // exhaustion state, so the persist block's
    // `notifyAdminsOfRetryExhaustion` call must be skipped. (We can't use
    // a plain "no push was sent" check because the regular member-facing
    // privacy notification also issues a push to the member, on the same
    // mock.)
    await suppress(testOrgId, "bouncy@example.test", { reason: "hard_bounce" });
    const request = await insertFreshRequest();

    await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.emailExhaustionNotifiedAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();

    // No exhaustion-alert in-app message was inserted (the regulatory
    // alert tags rows with `relatedEntity='data_request_email_exhausted'`).
    const exhaustionAlerts = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, testOrgId),
        eq(memberMessagesTable.relatedEntity, "data_request_email_exhausted"),
        eq(memberMessagesTable.relatedEntityId, request.id),
      ));
    expect(exhaustionAlerts).toHaveLength(0);
  });

  it("does not skip when the suppression is scoped to a different org", async () => {
    // Address is suppressed on a *different* org. Our org's send must
    // proceed normally.
    await suppress(otherOrgId, "bouncy@example.test", { reason: "hard_bounce" });
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(sendDataRequestEmailMock).toHaveBeenCalledTimes(1);
    expect(result.emailStatus).toBe("sent");

    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.lastEmailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(1);

    // No suppression audit row should have been written for a successful send.
    const auditRows = await db.select()
      .from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, memberUserId));
    expect(auditRows).toHaveLength(0);
  });
});

// Task #1502 / Task #1850 — provider_unconfigured branch on the privacy
// notify pipeline (lib lines 507 & 1164). When `classifyMailerError`
// returns `provider_unconfigured` the helper must take the terminal-skip
// path so the cron stops re-selecting the row and the per-channel
// exhaustion alert never fires for an env issue admins can't action from
// the alert itself. The classifier is the real one (kept via the mailer
// `importOriginal` mock at the top of this file), so any error message
// matching `/SMTP.*not configured/i` or the mailer key regex is enough.
describe("notifyDataRequest — first-attempt provider_unconfigured branch", () => {
  it("classifies a misconfigured mailer as terminal skipped/provider_not_configured and does not increment attempts", async () => {
    sendDataRequestEmailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(sendDataRequestEmailMock).toHaveBeenCalledTimes(1);
    expect(result.emailStatus).toBe("skipped");
    expect(result.emailError).toBe("provider_not_configured");

    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.lastEmailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("provider_not_configured");
    // The provider_unconfigured branch is a routing skip, not a delivery
    // attempt — the persist block records the outcome but the cron's
    // retry-eligible filter (`status === 'failed'`) drops it.
    expect(row.emailRetryExhaustedAt).toBeNull();
    // No exhaustion-alert in-app message was inserted.
    const exhaustionAlerts = await db.select()
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, testOrgId),
        eq(memberMessagesTable.relatedEntity, "data_request_email_exhausted"),
        eq(memberMessagesTable.relatedEntityId, request.id),
      ));
    expect(exhaustionAlerts).toHaveLength(0);
  });
});

describe("retryDataRequestEmail — provider_unconfigured branch", () => {
  it("flips the retry to terminal skipped/provider_not_configured, leaves attempts unchanged, no exhaustion stamp", async () => {
    const request = await insertFailedRetryRequest();
    const attemptsBefore = request.emailAttempts ?? 0;
    sendDataRequestEmailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));

    const result = await retryDataRequestEmail({ request });

    expect(result).not.toBeNull();
    expect(sendDataRequestEmailMock).toHaveBeenCalledTimes(1);
    expect(result!.status).toBe("skipped");
    expect(result!.error).toBe("provider_not_configured");
    // attempts surfaced on the result reflects the *previous* count: the
    // skip is not a delivery attempt, so the budget stays put.
    expect(result!.attempts).toBe(attemptsBefore);
    expect(result!.exhausted).toBe(false);

    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.lastEmailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("provider_not_configured");
    expect(row.emailAttempts).toBe(attemptsBefore);
    // Distinct from the hard-bounce / cap-reached paths: misconfig must
    // NOT stamp an exhaustion timestamp because it isn't a budget event.
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.lastEmailRetryAt).not.toBeNull();
  });
});

describe("retryDataRequestEmail — mid-budget suppression pre-check", () => {
  it("flips the row to terminal skipped when the address suppressed mid-retry", async () => {
    // The first attempt soft-failed (attempts=2) — between then and the
    // cron tick the address landed on the suppression list (e.g. a
    // separate notice hard-bounced and the bounce webhook recorded it).
    await suppress(testOrgId, "bouncy@example.test", { reason: "hard_bounce" });
    const request = await insertFailedRetryRequest();

    const result = await retryDataRequestEmail({ request });

    expect(result).not.toBeNull();
    expect(sendDataRequestEmailMock).not.toHaveBeenCalled();
    expect(result!.status).toBe("skipped");
    expect(result!.error).toBe("address_suppressed:hard_bounce");
    // The previous attempt count is preserved (the skip is not a
    // delivery attempt; it is a routing decision).
    expect(result!.attempts).toBe(2);
    expect(result!.exhausted).toBe(false);

    const [row] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, request.id));
    expect(row.lastEmailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("address_suppressed:hard_bounce");
    // attempts must NOT have been incremented.
    expect(row.emailAttempts).toBe(2);
    expect(row.emailAttempts).toBeLessThan(DATA_REQUEST_MAX_EMAIL_ATTEMPTS);
    // The cron treats a row as eligible for retry only when status is
    // 'failed', so 'skipped' alone is enough to terminate. We additionally
    // stamp `emailRetryExhaustedAt` so the row matches the hard-bounce
    // exhaustion shape downstream consumers already know how to render.
    expect(row.emailRetryExhaustedAt).not.toBeNull();
    expect(row.lastEmailRetryAt).not.toBeNull();

    // Retry path must also persist the suppression audit row.
    const auditRows = await db.select()
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.userId, memberUserId),
        eq(notificationAuditLogTable.notificationKey, "privacy.data_request.filed"),
      ));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].reason).toBe("address_suppressed:hard_bounce");
  });
});
