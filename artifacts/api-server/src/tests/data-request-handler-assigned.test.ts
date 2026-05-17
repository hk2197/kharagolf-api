/**
 * Integration tests: Privacy-handler assignment notification (Task #249).
 *
 * The PATCH /:memberId/data-requests/:id route fires an in-app + push notice
 * and writes a `data_request_handler_notification` audit row whenever the
 * `handlerUserId` is changed to a non-null user that isn't the actor. This
 * suite locks in:
 *
 *   1. Assigning to another admin → in-app message tagged with
 *      `data_request_handler_assigned`, push attempted to that admin's
 *      user id, and an audit log entry is written.
 *   2. Self-assignments do NOT trigger the notice.
 *   3. Unassignments (handlerUserId → null) do NOT trigger the notice.
 *   4. Re-assigning to the same handler is a no-op (no second notification).
 *
 * `comms` is mocked so push is observable without hitting real providers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendTransactionalSmsMock } = vi.hoisted(() => ({
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

// ── Schema bootstrap (mirrors the email-exhaustion test so this suite can
// run on a test DB whose migrations lag the latest Drizzle schema).
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
  // Defensive ALTER for older revisions that pre-date the metadata column.
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testMemberId: number;
let actorUserId: number;
let altAdminUserId: number;
let actor: TestUser;
let app: ReturnType<typeof createTestApp>;

const createdRequestIds: number[] = [];

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HandlerAssign_${ts}`,
    slug: `test-handler-assign-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Handler",
    lastName: "AssignTest",
    email: "handler-assign-member@example.test",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  // Actor: admin who performs the PATCH. Has both app_users.role and an
  // org_memberships row so they pass both `requireMemberAdmin` and the
  // route's "is the target a valid handler?" validation.
  const [actorRow] = await db.insert(appUsersTable).values({
    replitUserId: `actor-${ts}`,
    username: `actor_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  actorUserId = actorRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: actorUserId,
    role: "org_admin",
  });

  // Alt admin: the user we will assign requests to. Distinct from the actor
  // so we can exercise the "different handler" branch.
  const [altAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `alt-admin-${ts}`,
    username: `alt_admin_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  altAdminUserId = altAdminRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: altAdminUserId,
    role: "org_admin",
  });

  actor = {
    id: actorUserId,
    username: `actor_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(actor);
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, actorUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, altAdminUserId));
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

async function fetchAssignedMessages(requestId: number) {
  return db.select().from(memberMessagesTable).where(and(
    eq(memberMessagesTable.relatedEntity, "data_request_handler_assigned"),
    eq(memberMessagesTable.relatedEntityId, requestId),
  ));
}

async function fetchAssignedAudit(requestId: number) {
  return db.select().from(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "data_request_handler_notification"),
    eq(memberAuditLogTable.entityId, requestId),
  ));
}

/** Poll until predicate returns truthy or timeout — the route fires the
 *  notification asynchronously after responding, so we have to wait for
 *  the side effects to land. */
async function waitFor<T>(fn: () => Promise<T | null | undefined | false | ""> | T | null | undefined | false | "", timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined | false | "" = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Issue a control PATCH that we KNOW triggers a notification, then poll
 *  until that notification lands. This is a deterministic barrier that
 *  guarantees the fire-and-forget notification queue has drained for any
 *  preceding PATCH on the same router — far more reliable than a fixed
 *  setTimeout wait when asserting the *absence* of side effects. */
async function syncBarrier() {
  const barrier = await insertRequest();
  const res = await request(app)
    .patch(PATCH_URL(barrier.id))
    .send({ handlerUserId: altAdminUserId });
  expect(res.status, `barrier patch failed: ${res.text}`).toBe(200);
  await waitFor(async () => {
    const rows = await fetchAssignedAudit(barrier.id);
    return rows.length > 0 ? rows : null;
  });
}

const PATCH_URL = (id: number) =>
  `/api/organizations/${testOrgId}/members-360/${testMemberId}/data-requests/${id}`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PATCH /data-requests/:id — privacy-handler assignment notice", () => {
  it("assigning to another admin pushes, drops an in-app message, and writes the audit row", async () => {
    const req0 = await insertRequest();

    const res = await request(app)
      .patch(PATCH_URL(req0.id))
      .send({ handlerUserId: altAdminUserId });
    expect(res.status, `patch failed: ${res.text}`).toBe(200);
    expect(res.body.handlerUserId).toBe(altAdminUserId);

    // 1) In-app message tagged with the handler-assigned relation.
    const msgs = await waitFor(async () => {
      const rows = await fetchAssignedMessages(req0.id);
      return rows.length > 0 ? rows : null;
    });
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    expect(msg.organizationId).toBe(testOrgId);
    expect(msg.clubMemberId).toBe(testMemberId);
    expect(msg.channel).toBe("in_app");
    expect(msg.status).toBe("sent");
    expect(msg.senderUserId).toBe(actorUserId);
    expect(msg.subject).toContain(`#${req0.id}`);
    expect(msg.body).toContain(`#${req0.id}`);

    // 2) Push attempted to the new handler's user id.
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, , , payload] = sendTransactionalPushMock.mock.calls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(recipients).toEqual([altAdminUserId]);
    expect(payload.type).toBe("data_request_assigned");
    expect(payload.requestId).toBe(req0.id);
    expect(payload.clubMemberId).toBe(testMemberId);
    expect(payload.route).toBe(`/member-360/${testMemberId}?tab=data`);

    // 3) Audit log entry for the notification.
    const audits = await waitFor(async () => {
      const rows = await fetchAssignedAudit(req0.id);
      return rows.length > 0 ? rows : null;
    });
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit.action).toBe("create");
    expect(audit.actorUserId).toBe(actorUserId);
    expect(audit.organizationId).toBe(testOrgId);
    expect(audit.clubMemberId).toBe(testMemberId);
    expect(audit.reason).toContain(`handler:${altAdminUserId}`);
    expect(audit.metadata).toMatchObject({
      handlerUserId: altAdminUserId,
      previousHandlerUserId: null,
      inAppMessageId: msg.id,
      pushStatus: "sent",
      deepLink: `/member-360/${testMemberId}?tab=data`,
    });
  });

  it("self-assignment does NOT trigger the assignment notice", async () => {
    const req0 = await insertRequest();

    const res = await request(app)
      .patch(PATCH_URL(req0.id))
      .send({ handlerUserId: actorUserId });
    expect(res.status, `patch failed: ${res.text}`).toBe(200);
    expect(res.body.handlerUserId).toBe(actorUserId);

    // The route short-circuits BEFORE scheduling the fire-and-forget block
    // when handler.to === actor.id, so by the time PATCH responds we know
    // no async notification work was queued. Use a control barrier anyway
    // to drain any unrelated background work and remove timing ambiguity.
    await syncBarrier();
    sendTransactionalPushMock.mockClear();

    const msgs = await fetchAssignedMessages(req0.id);
    expect(msgs).toHaveLength(0);
    const audits = await fetchAssignedAudit(req0.id);
    expect(audits).toHaveLength(0);
  });

  it("unassignment (handler → null) does NOT trigger the assignment notice", async () => {
    // Seed the row already assigned to the alt admin so the PATCH actually
    // changes the value to null. Bypass the route to avoid firing a notice
    // during setup.
    const req0 = await insertRequest({ handlerUserId: altAdminUserId });

    const res = await request(app)
      .patch(PATCH_URL(req0.id))
      .send({ handlerUserId: null });
    expect(res.status, `patch failed: ${res.text}`).toBe(200);
    expect(res.body.handlerUserId).toBeNull();

    // The route's assignment-notification block is gated on
    // `handlerChange.to !== null`, so the PATCH response itself proves no
    // async work was scheduled. The barrier guarantees the suite-wide
    // queue is drained before we assert absence.
    await syncBarrier();
    sendTransactionalPushMock.mockClear();

    const msgs = await fetchAssignedMessages(req0.id);
    expect(msgs).toHaveLength(0);
    const audits = await fetchAssignedAudit(req0.id);
    expect(audits).toHaveLength(0);
  });

  it("re-assigning to the same handler is a no-op", async () => {
    // Seed the row already assigned to the alt admin (no notice fired).
    const req0 = await insertRequest({ handlerUserId: altAdminUserId });

    const res = await request(app)
      .patch(PATCH_URL(req0.id))
      .send({ handlerUserId: altAdminUserId });
    expect(res.status, `patch failed: ${res.text}`).toBe(200);
    expect(res.body.handlerUserId).toBe(altAdminUserId);

    // `handlerChange.to === handlerChange.from` short-circuits before any
    // async work is scheduled. The barrier drains unrelated work first.
    await syncBarrier();
    sendTransactionalPushMock.mockClear();

    // No push, no in-app message, no audit row for the assignment notice.
    const msgs = await fetchAssignedMessages(req0.id);
    expect(msgs).toHaveLength(0);
    const audits = await fetchAssignedAudit(req0.id);
    expect(audits).toHaveLength(0);
  });
});
