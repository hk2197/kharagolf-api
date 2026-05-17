/**
 * Task #2246 — Integration test: suppression-skipped privacy notices surface
 * on the controller-facing "Suppressed notifications" page.
 *
 * Task #2230 writes a `notification_audit_log` row whenever a privacy-request
 * email is skipped because the recipient address is on the org's
 * `email_suppressions` list (status `skipped`, reason
 * `address_suppressed:<reason>`, key `privacy.data_request.<kind>`).
 * Task #1775 (`GET /api/portal/notification-audit`) classifies any skipped
 * row whose reason is NOT `event_opted_out` as `system_suppressed` so the
 * controller-facing UI can render it under the "Suppressed notifications"
 * tab next to user-mute skips.
 *
 * The wire-up between those two tasks was previously covered only by:
 *   - The unit-shape test in
 *     `data-request-email-suppression-precheck.test.ts` (asserts the audit
 *     row is written, but never reads it back through the portal route).
 *   - The portal route's own unit tests in
 *     `portal-notification-audit.test.ts` (assert the kind discriminator
 *     works for synthetically-inserted rows, but never exercise the
 *     suppression-driven privacy-skip producer).
 *
 * This suite closes the loop: it triggers a real
 * `notifyDataRequest({ kind: "filed" })` against a member whose email is on
 * the org suppression list, then calls `GET /api/portal/notification-audit`
 * as the affected member's app-user and asserts the row surfaces with
 * `kind = "system_suppressed"`,
 * `reason = "address_suppressed:<suppression-reason>"`, and
 * `notificationKey = "privacy.data_request.<kind>"`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// `comms` and `mailer` are mocked so the unrelated push/email fan-out
// fired by `notifyDataRequest` does not require live providers — we only
// care about the suppression skip + the audit-log row it writes. The
// suppression branch never reaches `sendDataRequestEmail` (that's the
// whole point of the skip), but the helper still issues an in-app
// `member_messages` insert and a member-facing push, both of which run
// through these mocks.
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

import {
  db,
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { notifyDataRequest } from "../lib/dataRequestNotify.js";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let memberUserId: number;
let clubMemberId: number;
const createdRequestIds: number[] = [];

beforeAll(async () => {
  const tag = uid("portal-audit-data-request-supp");

  const [org] = await db.insert(organizationsTable).values({
    name: `Portal Audit Data-Request Suppression ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // The member must be linked to an app user so the portal route's
  // `userId = req.user.id` filter on `notification_audit_log` matches the
  // row that `writeDataRequestSuppressionAudit` writes (it copies
  // `userId` from `clubMembers.userId`). An anonymous member would write
  // a row with `userId = null` that the portal endpoint deliberately
  // hides — that's also worth covering, but the wire-up under test
  // requires a logged-in member.
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Bouncing Controller",
    email: `${tag}@example.test`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = u.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Bouncing",
    lastName: "Controller",
    email: "bouncy@example.test",
    userId: memberUserId,
  }).returning({ id: clubMembersTable.id });
  clubMemberId = member.id;
});

afterAll(async () => {
  if (createdRequestIds.length > 0) {
    await db.delete(memberDataRequestsTable)
      .where(inArray(memberDataRequestsTable.id, createdRequestIds));
  }
  await db.delete(notificationAuditLogTable)
    .where(eq(notificationAuditLogTable.userId, memberUserId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendDataRequestEmailMock.mockClear();
  // Wipe rows leftover from prior `it` blocks so the per-test assertions
  // can reason about *only* the row(s) they create.
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  await db.delete(notificationAuditLogTable)
    .where(eq(notificationAuditLogTable.userId, memberUserId));
});

describe("GET /api/portal/notification-audit — suppression-driven privacy skip", () => {
  it("surfaces the audit row written by notifyDataRequest as system_suppressed with the privacy notification key", async () => {
    // Arrange: member's address is on the org suppression list, then a
    // privacy request acknowledgement notice fires. The notice is the
    // canonical `filed` kind (sent right after the controller files the
    // request), but any `DataRequestEmailKind` would exercise the same
    // wire-up — we pick `filed` so the test reads as the most common
    // real-world scenario.
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: "bouncy@example.test",
      reason: "hard_bounce",
      bounceType: "permanent",
      description: "smtp 550 user unknown",
    });

    const requestedAt = new Date();
    const [reqRow] = await db.insert(memberDataRequestsTable).values({
      organizationId: orgId,
      clubMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt,
      dueBy: new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(reqRow.id);

    const result = await notifyDataRequest({
      organizationId: orgId,
      request: reqRow,
      kind: "filed",
    });

    // Sanity: the suppression branch fired (so we have a row to look at).
    // If this fails the rest of the assertions wouldn't be meaningful.
    expect(sendDataRequestEmailMock).not.toHaveBeenCalled();
    expect(result.emailStatus).toBe("skipped");
    expect(result.emailError).toBe("address_suppressed:hard_bounce");

    // Act: the affected member opens the portal's "Suppressed notifications"
    // page. The portal route reads `req.user.id` and surfaces audit rows
    // where `userId` matches the caller, so we authenticate as the same
    // app user that the member is linked to.
    const app = createTestApp({ id: memberUserId, username: "bouncy", role: "player" });
    const res = await request(app).get("/api/portal/notification-audit");

    // Assert: the suppression-skip row surfaces with the contract the
    // task describes — `kind = system_suppressed` (so the UI renders the
    // system-suppressed badge, not the user-mute badge),
    // `reason = address_suppressed:<suppression-reason>` (so the UI can
    // render the underlying suppression cause), and `notificationKey =
    // privacy.data_request.<kind>` (so deep-links and key-filtered
    // queries continue to work).
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<{
      notificationKey: string;
      kind: string;
      reason: string | null;
      channel: string;
      status: string;
      payload: Record<string, unknown>;
    }>;

    const suppressionEntries = entries.filter(
      e => e.notificationKey === "privacy.data_request.filed",
    );
    expect(suppressionEntries).toHaveLength(1);

    const entry = suppressionEntries[0];
    expect(entry.kind).toBe("system_suppressed");
    expect(entry.reason).toBe("address_suppressed:hard_bounce");
    // The `system_suppressed` discriminator hinges on the reason NOT
    // matching `event_opted_out`; assert that explicitly so a future
    // refactor that accidentally re-routes the suppression skip through
    // the user-mute reason fails loudly here.
    expect(entry.reason).not.toBe("event_opted_out");
    expect(entry.notificationKey).toBe("privacy.data_request.filed");
    expect(entry.channel).toBe("email");
    expect(entry.status).toBe("skipped");
    // The payload is the controller's only deep link back to the
    // originating request — confirm the producer wired through the
    // request id and kind so the UI can offer "view request" without
    // a second round-trip.
    expect(entry.payload.requestId).toBe(reqRow.id);
    expect(entry.payload.kind).toBe("filed");
    expect(entry.payload.suppressionReason).toBe("hard_bounce");
  });

  it("propagates the underlying suppression reason through the address_suppressed:<reason> wire and keys it on the notice kind", async () => {
    // A second scenario with a different suppression reason and a
    // different notice kind, to lock in that the producer emits
    // `address_suppressed:<reason>` verbatim (not a hard-coded
    // hard_bounce) and that the notification key tracks the
    // `DataRequestEmailKind` argument (not a hard-coded `filed`). A
    // regression that hard-codes either field would silently pass the
    // first test above and fail here.
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: "bouncy@example.test",
      reason: "complaint",
      bounceType: null,
      description: "marked as spam",
    });

    const requestedAt = new Date();
    const [reqRow] = await db.insert(memberDataRequestsTable).values({
      organizationId: orgId,
      clubMemberId,
      requestType: "erasure",
      status: "in_progress",
      requestedAt,
      dueBy: new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(reqRow.id);

    await notifyDataRequest({
      organizationId: orgId,
      request: reqRow,
      kind: "in_progress",
    });

    const app = createTestApp({ id: memberUserId, username: "bouncy", role: "player" });
    const res = await request(app).get("/api/portal/notification-audit");
    expect(res.status).toBe(200);

    const entries = res.body.entries as Array<{
      notificationKey: string;
      kind: string;
      reason: string | null;
    }>;
    const match = entries.find(e => e.notificationKey === "privacy.data_request.in_progress");
    expect(match).toBeDefined();
    expect(match!.kind).toBe("system_suppressed");
    expect(match!.reason).toBe("address_suppressed:complaint");
  });

  it("also surfaces the row when filtered via ?key=privacy.data_request.<kind>", async () => {
    // Controllers reach this page from a deep-link on a specific notice
    // ("show me what happened with my privacy acknowledgement"), which
    // relies on the `?key=` filter routing the producer's notification
    // key back to the row. Exercising the filter here proves the
    // round-trip works for the suppression-driven row specifically, not
    // just the synthetic rows that the existing portal-route tests use.
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: "bouncy@example.test",
      reason: "unsubscribed",
      bounceType: null,
      description: "list-unsubscribe header",
    });

    const requestedAt = new Date();
    const [reqRow] = await db.insert(memberDataRequestsTable).values({
      organizationId: orgId,
      clubMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt,
      dueBy: new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(reqRow.id);

    await notifyDataRequest({
      organizationId: orgId,
      request: reqRow,
      kind: "filed",
    });

    const app = createTestApp({ id: memberUserId, username: "bouncy", role: "player" });
    const res = await request(app)
      .get(`/api/portal/notification-audit?key=${encodeURIComponent("privacy.data_request.filed")}`);
    expect(res.status).toBe(200);

    const entries = res.body.entries as Array<{
      notificationKey: string;
      kind: string;
      reason: string | null;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.notificationKey).toBe("privacy.data_request.filed");
    }
    const match = entries.find(e => e.reason === "address_suppressed:unsubscribed");
    expect(match).toBeDefined();
    expect(match!.kind).toBe("system_suppressed");

    // Sanity: confirm the producer actually wrote the row we just read
    // back, so a JOIN regression on the read side cannot be
    // misinterpreted as a producer regression.
    const writtenRows = await db.select()
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.userId, memberUserId),
        eq(notificationAuditLogTable.notificationKey, "privacy.data_request.filed"),
      ));
    expect(writtenRows.length).toBeGreaterThan(0);
  });
});
