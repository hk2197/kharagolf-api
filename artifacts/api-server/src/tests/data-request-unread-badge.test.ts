/**
 * Integration tests: dashboard "Assigned to me" unread-count badge clears
 * when the handler opens the Member 360 Data tab (Task #284 / Task #337).
 *
 * The dashboard `PrivacyRequestsWidget` shows a numeric badge next to the
 * "Assigned to me" filter sourced from `unreadAssignedToMe` returned by
 * GET /data-requests/open. A request is "unread for the current handler"
 * iff the latest `data_request_handler_assigned` member_messages row tied
 * to the request has `read_at IS NULL`. Loading the Member 360 Data tab
 * (GET /:memberId/data-requests) marks any such pending notices as read
 * for requests the viewer is the handler of, which is what flushes the
 * badge to zero.
 *
 * This suite locks in:
 *   1. Assign → badge shows 1 with the row flagged `assignmentUnread`,
 *      then opening the Data tab as the assignee clears it on the next
 *      open-list reload.
 *   2. Reassignment to a different handler swaps the badge: the new
 *      handler sees 1, the prior handler sees 0.
 *
 * `comms` is mocked so the assignment push doesn't hit real providers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendTransactionalSmsMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendTransactionalSmsMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

// ── Schema bootstrap (mirrors data-request-handler-assigned.test.ts so this
// suite can run on a test DB whose migrations lag the latest Drizzle schema).
async function ensurePrivacySchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz,
      error_message text,
      related_entity text,
      related_entity_id integer
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz,
      resolved_at timestamptz,
      notes text,
      artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      last_notification_kind text,
      last_notified_at timestamptz,
      last_email_status text,
      last_email_at timestamptz,
      last_email_error text,
      last_in_app_message_id integer REFERENCES member_messages(id) ON DELETE SET NULL,
      last_in_app_at timestamptz,
      last_push_status text,
      last_push_at timestamptz,
      last_push_error text,
      last_sms_status text,
      last_sms_at timestamptz,
      last_sms_error text,
      push_attempts integer NOT NULL DEFAULT 0,
      sms_attempts integer NOT NULL DEFAULT 0,
      last_push_retry_at timestamptz,
      last_sms_retry_at timestamptz,
      push_retry_exhausted_at timestamptz,
      sms_retry_exhausted_at timestamptz,
      email_attempts integer NOT NULL DEFAULT 0,
      last_email_retry_at timestamptz,
      email_retry_exhausted_at timestamptz,
      email_exhaustion_notified_at timestamptz,
      push_exhaustion_notified_at timestamptz,
      sms_exhaustion_notified_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text,
      actor_role text,
      entity text NOT NULL,
      entity_id integer,
      action text NOT NULL,
      field_changes jsonb,
      reason text,
      metadata jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testMemberId: number;
let actorUserId: number;     // performs PATCH assignments — must not be the assignee
let handlerAUserId: number;  // first handler under test
let handlerBUserId: number;  // reassignment target
let actorApp: ReturnType<typeof createTestApp>;
let handlerAApp: ReturnType<typeof createTestApp>;
let handlerBApp: ReturnType<typeof createTestApp>;

const createdRequestIds: number[] = [];

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_UnreadBadge_${ts}`,
    slug: `test-unread-badge-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Unread",
    lastName: "BadgeTest",
    email: "unread-badge-member@example.test",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  async function makeAdmin(label: string): Promise<TestUser> {
    const [row] = await db.insert(appUsersTable).values({
      replitUserId: `${label}-${ts}`,
      username: `${label}_${ts}`,
      role: "org_admin",
      organizationId: testOrgId,
    }).returning({ id: appUsersTable.id });
    await db.insert(orgMembershipsTable).values({
      organizationId: testOrgId,
      userId: row.id,
      role: "org_admin",
    });
    return {
      id: row.id,
      username: `${label}_${ts}`,
      role: "org_admin",
      organizationId: testOrgId,
    };
  }

  const actor = await makeAdmin("actor-badge");
  const handlerA = await makeAdmin("handlerA-badge");
  const handlerB = await makeAdmin("handlerB-badge");
  actorUserId = actor.id;
  handlerAUserId = handlerA.id;
  handlerBUserId = handlerB.id;

  actorApp = createTestApp(actor);
  handlerAApp = createTestApp(handlerA);
  handlerBApp = createTestApp(handlerB);
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const uid of [actorUserId, handlerAUserId, handlerBUserId]) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function insertRequest(overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {}) {
  const now = new Date();
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "pending",
    requestedAt: now,
    dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  }).returning();
  createdRequestIds.push(row.id);
  return row;
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false | ""> | T | null | undefined | false | "",
  timeoutMs = 3000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const PATCH_URL = (id: number) =>
  `/api/organizations/${testOrgId}/members-360/${testMemberId}/data-requests/${id}`;
const OPEN_URL = () =>
  `/api/organizations/${testOrgId}/members-360/data-requests/open?assignedToMe=true`;
const DATA_TAB_URL = () =>
  `/api/organizations/${testOrgId}/members-360/${testMemberId}/data-requests`;

/** Assign `requestId` to `handlerUserId` via the actor app and wait for the
 *  fire-and-forget handler-assigned in-app message to land. */
async function assignAndAwaitNotice(requestId: number, handlerUserId: number) {
  const res = await request(actorApp)
    .patch(PATCH_URL(requestId))
    .send({ handlerUserId });
  expect(res.status, `patch failed: ${res.text}`).toBe(200);
  expect(res.body.handlerUserId).toBe(handlerUserId);

  // The assignment notice is dispatched asynchronously after the response.
  // Poll member_messages until the latest handler-assigned row for this
  // request points at the new handler so the open-list reflects it.
  await waitFor(async () => {
    const rows = await db.select({
      id: memberMessagesTable.id,
      readAt: memberMessagesTable.readAt,
    }).from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.relatedEntity, "data_request_handler_assigned"),
        eq(memberMessagesTable.relatedEntityId, requestId),
      ))
      .orderBy(sql`${memberMessagesTable.id} DESC`);
    // We need at least one row whose read_at is null (i.e. the freshly
    // created assignment notice the handler has yet to acknowledge).
    return rows.find((r) => r.readAt == null) ?? null;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Dashboard 'Assigned to me' unread badge — clear-on-open lifecycle", () => {
  it("badge shows 1 after assignment and clears once the handler opens the Data tab", async () => {
    const req0 = await insertRequest();

    // (a) Assign to handler A.
    await assignAndAwaitNotice(req0.id, handlerAUserId);

    // (b) Handler A loads the dashboard widget — badge reads 1 and the row
    //     is flagged unread.
    const beforeOpen = await request(handlerAApp).get(OPEN_URL());
    expect(beforeOpen.status, beforeOpen.text).toBe(200);
    expect(beforeOpen.body.unreadAssignedToMe).toBe(1);
    const beforeRow = (beforeOpen.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
      .find((r) => r.id === req0.id);
    expect(beforeRow, "assigned request should appear in handler A's mine-only list").toBeDefined();
    expect(beforeRow!.assignmentUnread).toBe(true);

    // (c) Handler A opens the Member 360 Data tab — this is the request the
    //     dashboard deep-links to and the read-receipt trigger.
    const dataTab = await request(handlerAApp).get(DATA_TAB_URL());
    expect(dataTab.status, dataTab.text).toBe(200);

    // (d) Reload the dashboard widget — badge is gone and the row is no
    //     longer flagged unread.
    const afterOpen = await request(handlerAApp).get(OPEN_URL());
    expect(afterOpen.status, afterOpen.text).toBe(200);
    expect(afterOpen.body.unreadAssignedToMe).toBe(0);
    const afterRow = (afterOpen.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
      .find((r) => r.id === req0.id);
    expect(afterRow, "request should still be in handler A's mine-only list").toBeDefined();
    expect(afterRow!.assignmentUnread).toBe(false);
  });

  it("reassigning the request swaps the badge to the new handler and clears it for the prior handler", async () => {
    const req0 = await insertRequest();

    // Initial assignment to handler A — A sees the badge.
    await assignAndAwaitNotice(req0.id, handlerAUserId);
    {
      const r = await request(handlerAApp).get(OPEN_URL());
      expect(r.status, r.text).toBe(200);
      expect(r.body.unreadAssignedToMe).toBe(1);
      const row = (r.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
        .find((x) => x.id === req0.id);
      expect(row?.assignmentUnread).toBe(true);
    }

    // Reassign to handler B — a fresh handler-assigned message is written
    // for B, and A is no longer the handler so the row drops out of A's
    // mine-only list (and certainly out of A's unread count).
    await assignAndAwaitNotice(req0.id, handlerBUserId);

    // Handler B sees the badge for this request.
    const bAfter = await request(handlerBApp).get(OPEN_URL());
    expect(bAfter.status, bAfter.text).toBe(200);
    const bRow = (bAfter.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
      .find((x) => x.id === req0.id);
    expect(bRow, "reassigned request should appear in handler B's mine-only list").toBeDefined();
    expect(bRow!.assignmentUnread).toBe(true);
    // The badge total reflects this row (it may include other unread rows
    // from prior tests in the same suite; just assert this row is counted).
    expect(bAfter.body.unreadAssignedToMe).toBeGreaterThanOrEqual(1);

    // Handler A no longer sees this request in their mine-only list, and
    // their badge is back to zero — the dashboard "Assigned to me" badge
    // must clear immediately for the prior handler the moment a reassign
    // happens (no manual acknowledgement required on their end).
    const aAfter = await request(handlerAApp).get(OPEN_URL());
    expect(aAfter.status, aAfter.text).toBe(200);
    const aRow = (aAfter.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
      .find((x) => x.id === req0.id);
    expect(aRow, "reassigned request should NOT appear in handler A's mine-only list").toBeUndefined();
    expect(aAfter.body.unreadAssignedToMe).toBe(0);

    // And opening the Data tab as B clears the badge for this request.
    const dataTab = await request(handlerBApp).get(DATA_TAB_URL());
    expect(dataTab.status, dataTab.text).toBe(200);
    const bCleared = await request(handlerBApp).get(OPEN_URL());
    expect(bCleared.status, bCleared.text).toBe(200);
    const bClearedRow = (bCleared.body.requests as Array<{ id: number; assignmentUnread: boolean }>)
      .find((x) => x.id === req0.id);
    expect(bClearedRow, "request should still be in handler B's mine-only list").toBeDefined();
    expect(bClearedRow!.assignmentUnread).toBe(false);
  });
});
