/**
 * Integration tests: Privacy push & SMS exhaustion admin alerts (Task 304).
 *
 * Task 261 added per-channel admin alerts when the privacy-notice push or SMS
 * retry caps are reached, mirroring the email-channel alert from Task 238.
 * The email exhaustion path is covered by `data-request-email-exhaustion.test.ts`;
 * this suite locks in equivalent behaviour for the **push** and **SMS**
 * branches so a future refactor can't silently regress per-channel parity.
 *
 * Coverage:
 *   1. Hitting `DATA_REQUEST_MAX_PUSH_ATTEMPTS` triggers the admin push +
 *      in-app message and stamps `pushExhaustionNotifiedAt`.
 *   2. Hitting `DATA_REQUEST_MAX_SMS_ATTEMPTS` triggers the admin push +
 *      in-app message and stamps `smsExhaustionNotifiedAt`.
 *   3. De-dup: a second alert call (e.g. a follow-up cron pass) for the same
 *      exhausted channel on the same notice does NOT re-alert.
 *   4. Reset: a fresh `notifyDataRequest` clears the new
 *      `pushExhaustionNotifiedAt` / `smsExhaustionNotifiedAt` stamps so a
 *      future exhaustion of *that* notice can re-alert admins on each
 *      channel independently.
 *
 * `comms` and `mailer` are mocked so push/SMS/email calls are observable
 * side-effects rather than real network calls.
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
vi.mock("../lib/mailer.js", () => ({
  sendDataRequestEmail: sendDataRequestEmailMock,
}));

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
import { and, eq, sql } from "drizzle-orm";
import {
  notifyAdminsOfRetryExhaustion,
  notifyDataRequest,
  DATA_REQUEST_MAX_PUSH_ATTEMPTS,
  DATA_REQUEST_MAX_SMS_ATTEMPTS,
} from "../lib/dataRequestNotify.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────
//
// Mirrors the bootstrap in `data-request-email-exhaustion.test.ts`. The
// privacy/comm schema lags in some test environments and drizzle-kit push is
// interactive, so we ensure the small subset of schema this test needs
// exists via idempotent DDL.
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
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS email_exhaustion_notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS push_exhaustion_notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS sms_exhaustion_notified_at timestamptz`);
  // WhatsApp columns are referenced by drizzle's generated insert SQL (Task
  // #296 added them to the schema even before all surfaces wire it up); the
  // table may pre-date that migration in some test envs.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_status text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_error text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_comm_prefs (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      category text NOT NULL,
      email_enabled boolean NOT NULL DEFAULT true,
      sms_enabled boolean NOT NULL DEFAULT false,
      push_enabled boolean NOT NULL DEFAULT true,
      whatsapp_enabled boolean NOT NULL DEFAULT false,
      in_app_enabled boolean NOT NULL DEFAULT true,
      quiet_hours_start text,
      quiet_hours_end text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testMemberId: number;
let directAdminId: number;
let membershipAdminId: number;
let handlerUserId: number;

const createdRequestIds: number[] = [];

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PushSmsExhaust_${ts}`,
    slug: `test-pushsms-exhaust-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Push",
    lastName: "Subject",
    email: "pushsms-member@example.test",
    phone: "+15555550199",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [directAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `pushsms-direct-admin-${ts}`,
    username: `pushsms_direct_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  directAdminId = directAdmin.id;

  const [membershipAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `pushsms-membership-admin-${ts}`,
    username: `pushsms_membership_admin_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipAdminId = membershipAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipAdminId,
    role: "org_admin",
  });

  const [handler] = await db.insert(appUsersTable).values({
    replitUserId: `pushsms-handler-${ts}`,
    username: `pushsms_handler_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  handlerUserId = handler.id;
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const uid of [directAdminId, membershipAdminId, handlerUserId]) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendDataRequestEmailMock.mockClear();
});

/**
 * Insert a fresh privacy request whose chosen channel is in the `failed` /
 * exhausted state, ready to be alerted on. `channel` controls which channel
 * is set up at the cap; the others are left in their initial neutral state.
 */
async function insertExhaustedRequest(
  channel: "push" | "sms",
  overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {},
): Promise<MemberDataRequest> {
  const now = new Date();
  const base: typeof memberDataRequestsTable.$inferInsert = {
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "in_progress",
    requestedAt: now,
    dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    lastNotificationKind: "filed",
    lastNotifiedAt: now,
  };
  if (channel === "push") {
    base.lastPushStatus = "failed";
    base.lastPushAt = now;
    base.lastPushError = "push_delivery_failed";
    base.pushAttempts = DATA_REQUEST_MAX_PUSH_ATTEMPTS;
    base.lastPushRetryAt = now;
    base.pushRetryExhaustedAt = now;
  } else {
    base.lastSmsStatus = "failed";
    base.lastSmsAt = now;
    base.lastSmsError = "twilio 21610 unsubscribed";
    base.smsAttempts = DATA_REQUEST_MAX_SMS_ATTEMPTS;
    base.lastSmsRetryAt = now;
    base.smsRetryExhaustedAt = now;
  }
  const [row] = await db.insert(memberDataRequestsTable).values({ ...base, ...overrides }).returning();
  createdRequestIds.push(row.id);
  return row as MemberDataRequest;
}

// ── 1. Push exhaustion alert ───────────────────────────────────────────────

describe("notifyAdminsOfRetryExhaustion — push channel", () => {
  it("stamps pushExhaustionNotifiedAt, fires admin push, and writes a tagged in-app message", async () => {
    const request = await insertExhaustedRequest("push", { handlerUserId });

    const result = await notifyAdminsOfRetryExhaustion({ channel: "push", request });

    expect(result.notified).toBe(true);
    // direct admin + membership admin + handler = 3 distinct recipients
    expect(result.recipients).toBe(3);

    // Stamp persisted on the request row.
    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.pushExhaustionNotifiedAt).not.toBeNull();
    // Other channel stamps are independent and untouched.
    expect(reloaded.smsExhaustionNotifiedAt).toBeNull();
    expect(reloaded.emailExhaustionNotifiedAt).toBeNull();

    // Admin push was fanned out with the push-specific notif type.
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, , data] = sendTransactionalPushMock.mock.calls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(new Set(recipients)).toEqual(new Set([directAdminId, membershipAdminId, handlerUserId]));
    expect(title).toContain("push");
    expect(data.type).toBe("data_request_push_exhausted");
    expect(data.requestId).toBe(request.id);

    // In-app message tagged for Member 360 grouping.
    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe("in_app");
    expect(msgs[0].status).toBe("sent");
    expect(msgs[0].subject).toContain(`#${request.id}`);
    expect(msgs[0].subject?.toLowerCase()).toContain("push");
    expect(msgs[0].body).toContain(`#${request.id}`);
  });
});

// ── 2. SMS exhaustion alert ────────────────────────────────────────────────

describe("notifyAdminsOfRetryExhaustion — sms channel", () => {
  it("stamps smsExhaustionNotifiedAt, fires admin push, and writes a tagged in-app message", async () => {
    const request = await insertExhaustedRequest("sms", { handlerUserId });

    const result = await notifyAdminsOfRetryExhaustion({ channel: "sms", request });

    expect(result.notified).toBe(true);
    expect(result.recipients).toBe(3);

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.smsExhaustionNotifiedAt).not.toBeNull();
    // Push/email stamps remain untouched.
    expect(reloaded.pushExhaustionNotifiedAt).toBeNull();
    expect(reloaded.emailExhaustionNotifiedAt).toBeNull();

    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, , data] = sendTransactionalPushMock.mock.calls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(new Set(recipients)).toEqual(new Set([directAdminId, membershipAdminId, handlerUserId]));
    expect(title).toContain("SMS");
    expect(data.type).toBe("data_request_sms_exhausted");
    expect(data.requestId).toBe(request.id);

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_sms_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe("in_app");
    expect(msgs[0].body).toContain(`#${request.id}`);
  });
});

// ── 3. De-duplication across cron passes ───────────────────────────────────

describe("notifyAdminsOfRetryExhaustion — push/sms dedup", () => {
  it("a second alert call for the same exhausted push notice is a no-op", async () => {
    const request = await insertExhaustedRequest("push");

    const first = await notifyAdminsOfRetryExhaustion({ channel: "push", request });
    expect(first.notified).toBe(true);

    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.pushExhaustionNotifiedAt).not.toBeNull();

    sendTransactionalPushMock.mockClear();

    // Second pass (e.g. another cron tick) — must not re-alert.
    const second = await notifyAdminsOfRetryExhaustion({
      channel: "push",
      request: stamped as MemberDataRequest,
    });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
  });

  it("a second alert call for the same exhausted SMS notice is a no-op", async () => {
    const request = await insertExhaustedRequest("sms");

    const first = await notifyAdminsOfRetryExhaustion({ channel: "sms", request });
    expect(first.notified).toBe(true);

    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.smsExhaustionNotifiedAt).not.toBeNull();

    sendTransactionalPushMock.mockClear();

    const second = await notifyAdminsOfRetryExhaustion({
      channel: "sms",
      request: stamped as MemberDataRequest,
    });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_sms_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
  });
});

// ── 4. Reset on a fresh notifyDataRequest ─────────────────────────────────

describe("notifyAdminsOfRetryExhaustion — reset on fresh notification", () => {
  it("clears pushExhaustionNotifiedAt so a future push exhaustion can re-alert", async () => {
    const request = await insertExhaustedRequest("push");

    await notifyAdminsOfRetryExhaustion({ channel: "push", request });
    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.pushExhaustionNotifiedAt).not.toBeNull();

    // A fresh privacy notification should reset the dedup stamp.
    await notifyDataRequest({
      organizationId: testOrgId,
      request: stamped as MemberDataRequest,
      kind: "in_progress",
    });

    const [afterFresh] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(afterFresh.pushExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.smsExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.emailExhaustionNotifiedAt).toBeNull();

    // Simulate the channel hitting the cap again so a follow-up alert is allowed.
    await db.update(memberDataRequestsTable).set({
      lastPushStatus: "failed",
      pushAttempts: DATA_REQUEST_MAX_PUSH_ATTEMPTS,
      lastPushError: "push_delivery_failed",
      pushRetryExhaustedAt: new Date(),
    }).where(eq(memberDataRequestsTable.id, request.id));
    const [requeued] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));

    sendTransactionalPushMock.mockClear();
    const replay = await notifyAdminsOfRetryExhaustion({
      channel: "push",
      request: requeued as MemberDataRequest,
    });
    expect(replay.notified).toBe(true);
    expect(replay.recipients).toBeGreaterThan(0);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
  });

  it("clears smsExhaustionNotifiedAt so a future SMS exhaustion can re-alert", async () => {
    const request = await insertExhaustedRequest("sms");

    await notifyAdminsOfRetryExhaustion({ channel: "sms", request });
    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.smsExhaustionNotifiedAt).not.toBeNull();

    await notifyDataRequest({
      organizationId: testOrgId,
      request: stamped as MemberDataRequest,
      kind: "in_progress",
    });

    const [afterFresh] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(afterFresh.smsExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.pushExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.emailExhaustionNotifiedAt).toBeNull();

    await db.update(memberDataRequestsTable).set({
      lastSmsStatus: "failed",
      smsAttempts: DATA_REQUEST_MAX_SMS_ATTEMPTS,
      lastSmsError: "twilio 21610 unsubscribed",
      smsRetryExhaustedAt: new Date(),
    }).where(eq(memberDataRequestsTable.id, request.id));
    const [requeued] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));

    sendTransactionalPushMock.mockClear();
    const replay = await notifyAdminsOfRetryExhaustion({
      channel: "sms",
      request: requeued as MemberDataRequest,
    });
    expect(replay.notified).toBe(true);
    expect(replay.recipients).toBeGreaterThan(0);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
  });
});
