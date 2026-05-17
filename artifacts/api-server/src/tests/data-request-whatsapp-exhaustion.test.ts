/**
 * Integration tests: Privacy WhatsApp channel — opt-in gate, retry telemetry,
 * cap exhaustion and admin alert (Task 297 / Task 349).
 *
 * The email/push/SMS privacy channels are each covered by their own
 * exhaustion suites (`data-request-email-exhaustion.test.ts`,
 * `data-request-push-sms-exhaustion.test.ts`). Task 297 added WhatsApp as a
 * 4th privacy notice channel with its own opt-in flag, attempt counter and
 * exhaustion-alert dedup. This suite locks in equivalent behaviour for the
 * **WhatsApp** branch so a future refactor can't silently regress per-channel
 * parity.
 *
 * Coverage:
 *   1. Opt-in gate — when the member has not opted into WhatsApp for the
 *      `privacy` category, `notifyDataRequest` records `opted_out` and
 *      never invokes `sendTransactionalWhatsapp`.
 *   2. Successful send telemetry — opted-in members get a WhatsApp send and
 *      the request row is stamped (`lastWhatsappStatus='sent'`,
 *      `whatsappAttempts=1`, `lastWhatsappAt` populated).
 *   3. Failed send increments `whatsappAttempts` — `retryDataRequestWhatsapp`
 *      bumps the attempt counter on each failed retry without exhausting
 *      until the cap.
 *   4. Cap exhaustion writes `whatsappRetryExhaustedAt` — the final failed
 *      retry stamps the exhaustion column and marks the result `exhausted`.
 *   5. Admin alert dedup via `whatsappExhaustionNotifiedAt` — a second
 *      `notifyAdminsOfRetryExhaustion({ channel: "whatsapp" })` for the same
 *      notice no-ops, no second admin push fan-out.
 *   6. Provider-not-configured graceful skip — both `notifyDataRequest` and
 *      `retryDataRequestWhatsapp` treat a `WHATSAPP_PROVIDER not configured`
 *      throw as terminal `skipped` instead of `failed`.
 *
 * `comms` and `mailer` are mocked so push/SMS/email/WhatsApp calls are
 * observable side-effects rather than real network calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const {
  sendTransactionalPushMock,
  sendTransactionalSmsMock,
  sendTransactionalWhatsappMock,
  sendDataRequestEmailMock,
} = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (_userIds: number[], _title: string, _body: string, _data?: Record<string, unknown>) =>
      ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendTransactionalSmsMock: vi.fn(async (_phone: string, _body: string) => undefined),
  sendTransactionalWhatsappMock: vi.fn(async (_phone: string, _body: string) => null as string | null),
  sendDataRequestEmailMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
  sendTransactionalWhatsapp: sendTransactionalWhatsappMock,
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
  memberCommPrefsTable,
  memberDataRequestsTable,
  memberMessagesTable,
  type MemberDataRequest,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  notifyAdminsOfRetryExhaustion,
  notifyDataRequest,
  retryDataRequestWhatsapp,
  DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
} from "../lib/dataRequestNotify.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────
//
// Mirrors the bootstrap in `data-request-push-sms-exhaustion.test.ts` so the
// dev DB has the WhatsApp telemetry columns from migration 0037 even if
// drizzle-kit push hasn't been applied yet (it is interactive in some envs).
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
      last_in_app_at timestamptz
    )
  `);
  // Per-channel telemetry columns added across tasks 238/261/297. All wrapped
  // in IF NOT EXISTS so the bootstrap is idempotent across envs.
  for (const ddl of [
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_push_status text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_push_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_push_error text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_sms_status text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_sms_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_sms_error text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS sms_attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_push_retry_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_sms_retry_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS push_retry_exhausted_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS sms_retry_exhausted_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_email_retry_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS email_retry_exhausted_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS email_exhaustion_notified_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS push_exhaustion_notified_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS sms_exhaustion_notified_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_status text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_error text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_exhaustion_notified_at timestamptz`,
  ]) {
    await db.execute(sql.raw(ddl));
  }
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
  await db.execute(sql`ALTER TABLE member_comm_prefs ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false`);
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
    name: `TestOrg_WhatsAppExhaust_${ts}`,
    slug: `test-wa-exhaust-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "WhatsApp",
    lastName: "Subject",
    email: "wa-member@example.test",
    phone: "+15555550144",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [directAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `wa-direct-admin-${ts}`,
    username: `wa_direct_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  directAdminId = directAdmin.id;

  const [membershipAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `wa-membership-admin-${ts}`,
    username: `wa_membership_admin_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipAdminId = membershipAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipAdminId,
    role: "org_admin",
  });

  const [handler] = await db.insert(appUsersTable).values({
    replitUserId: `wa-handler-${ts}`,
    username: `wa_handler_${ts}`,
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
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const uid of [directAdminId, membershipAdminId, handlerUserId]) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalPushMock.mockImplementation(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }));
  sendTransactionalSmsMock.mockClear();
  sendTransactionalWhatsappMock.mockClear();
  sendTransactionalWhatsappMock.mockImplementation(async () => null);
  sendDataRequestEmailMock.mockClear();
  // Each test starts with the WhatsApp opt-in cleared so individual tests
  // can choose whether to opt the member in.
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, testMemberId));
});

async function setWhatsappOptIn(enabled: boolean) {
  await db.insert(memberCommPrefsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    category: "privacy",
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: false, // keep push out of the way; this suite focuses on WhatsApp
    whatsappEnabled: enabled,
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

async function insertExhaustedWhatsappRequest(
  overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {},
): Promise<MemberDataRequest> {
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
    lastWhatsappStatus: "failed",
    lastWhatsappAt: now,
    lastWhatsappError: "msg91 422 invalid_template",
    whatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
    lastWhatsappRetryAt: now,
    whatsappRetryExhaustedAt: now,
    ...overrides,
  }).returning();
  createdRequestIds.push(row.id);
  return row as MemberDataRequest;
}

// ── 1. Opt-in gate ─────────────────────────────────────────────────────────

describe("notifyDataRequest — WhatsApp opt-in gate", () => {
  it("does not call the WhatsApp provider when the member has not opted in", async () => {
    // No member_comm_prefs row → defaults to whatsapp:false.
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(result.whatsappStatus).toBe("opted_out");
    expect(sendTransactionalWhatsappMock).not.toHaveBeenCalled();

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.lastWhatsappStatus).toBe("opted_out");
    expect(reloaded.whatsappAttempts).toBe(0);
    expect(reloaded.lastWhatsappAt).toBeNull();
  });
});

// ── 2. Successful send telemetry ───────────────────────────────────────────

describe("notifyDataRequest — WhatsApp successful send telemetry", () => {
  it("records lastWhatsappStatus='sent' and whatsappAttempts=1 on a successful send", async () => {
    await setWhatsappOptIn(true);
    const request = await insertFreshRequest();

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(result.whatsappStatus).toBe("sent");
    expect(sendTransactionalWhatsappMock).toHaveBeenCalledTimes(1);
    const [phone, body] = sendTransactionalWhatsappMock.mock.calls[0]!;
    expect(phone).toBe("+15555550144");
    expect(body).toContain(`#${request.id}`);

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.lastWhatsappStatus).toBe("sent");
    expect(reloaded.whatsappAttempts).toBe(1);
    expect(reloaded.lastWhatsappAt).not.toBeNull();
    expect(reloaded.lastWhatsappError).toBeNull();
    expect(reloaded.whatsappRetryExhaustedAt).toBeNull();
  });
});

// ── 3. Failed send increments whatsappAttempts ─────────────────────────────

describe("retryDataRequestWhatsapp — failed send increments whatsappAttempts", () => {
  it("bumps whatsappAttempts on each failed retry without exhausting until the cap", async () => {
    await setWhatsappOptIn(true);
    // Seed the row in a `failed` state with 1 prior attempt so it's eligible
    // for the retry cron.
    const now = new Date();
    const [seed] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: now,
      dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      lastNotificationKind: "filed",
      lastNotifiedAt: now,
      lastWhatsappStatus: "failed",
      lastWhatsappAt: now,
      lastWhatsappError: "msg91 503 service_unavailable",
      whatsappAttempts: 1,
    }).returning();
    createdRequestIds.push(seed.id);

    sendTransactionalWhatsappMock.mockImplementation(async () => {
      throw new Error("msg91 503 service_unavailable");
    });

    const r1 = await retryDataRequestWhatsapp({ request: seed as MemberDataRequest });
    expect(r1).not.toBeNull();
    expect(r1!.status).toBe("failed");
    expect(r1!.attempts).toBe(2);
    expect(r1!.exhausted).toBe(false);

    const [afterFirst] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, seed.id));
    expect(afterFirst.whatsappAttempts).toBe(2);
    expect(afterFirst.lastWhatsappStatus).toBe("failed");
    expect(afterFirst.lastWhatsappError).toBe("msg91 503 service_unavailable");
    expect(afterFirst.whatsappRetryExhaustedAt).toBeNull();
    expect(afterFirst.lastWhatsappRetryAt).not.toBeNull();

    // A second retry should bump to attempt 3, still not exhausted.
    const r2 = await retryDataRequestWhatsapp({ request: afterFirst as MemberDataRequest });
    expect(r2).not.toBeNull();
    expect(r2!.attempts).toBe(3);
    expect(r2!.exhausted).toBe(false);

    const [afterSecond] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, seed.id));
    expect(afterSecond.whatsappAttempts).toBe(3);
    expect(afterSecond.whatsappRetryExhaustedAt).toBeNull();
  });
});

// ── 4. Cap exhaustion writes whatsappRetryExhaustedAt ──────────────────────

describe("retryDataRequestWhatsapp — cap exhaustion", () => {
  it("stamps whatsappRetryExhaustedAt on the final failed attempt", async () => {
    await setWhatsappOptIn(true);
    // Seed the row one attempt below the cap so the next failed retry tips
    // it over the edge.
    const now = new Date();
    const [seed] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: now,
      dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      lastNotificationKind: "filed",
      lastNotifiedAt: now,
      lastWhatsappStatus: "failed",
      lastWhatsappAt: now,
      lastWhatsappError: "msg91 503 service_unavailable",
      whatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS - 1,
    }).returning();
    createdRequestIds.push(seed.id);

    sendTransactionalWhatsappMock.mockImplementation(async () => {
      throw new Error("msg91 503 service_unavailable");
    });

    const result = await retryDataRequestWhatsapp({ request: seed as MemberDataRequest });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.attempts).toBe(DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS);
    expect(result!.exhausted).toBe(true);

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, seed.id));
    expect(reloaded.whatsappAttempts).toBe(DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS);
    expect(reloaded.whatsappRetryExhaustedAt).not.toBeNull();
    expect(reloaded.lastWhatsappStatus).toBe("failed");

    // Once exhausted the retry helper refuses to re-attempt.
    sendTransactionalWhatsappMock.mockClear();
    const noOp = await retryDataRequestWhatsapp({ request: reloaded as MemberDataRequest });
    expect(noOp).toBeNull();
    expect(sendTransactionalWhatsappMock).not.toHaveBeenCalled();
  });
});

// ── 5. Admin alert dedup via whatsappExhaustionNotifiedAt ──────────────────

describe("notifyAdminsOfRetryExhaustion — whatsapp channel dedup", () => {
  it("stamps whatsappExhaustionNotifiedAt, fires admin push, and writes a tagged in-app message", async () => {
    const request = await insertExhaustedWhatsappRequest({ handlerUserId });

    const result = await notifyAdminsOfRetryExhaustion({ channel: "whatsapp", request });

    expect(result.notified).toBe(true);
    // direct admin + membership admin + handler = 3 distinct recipients
    expect(result.recipients).toBe(3);

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.whatsappExhaustionNotifiedAt).not.toBeNull();
    // Other channel stamps are independent and untouched.
    expect(reloaded.emailExhaustionNotifiedAt).toBeNull();
    expect(reloaded.pushExhaustionNotifiedAt).toBeNull();
    expect(reloaded.smsExhaustionNotifiedAt).toBeNull();

    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, , data] = sendTransactionalPushMock.mock.calls[0]!;
    expect(new Set(recipients)).toEqual(new Set([directAdminId, membershipAdminId, handlerUserId]));
    expect(title).toContain("WhatsApp");
    expect(data!.type).toBe("data_request_whatsapp_exhausted");
    expect(data!.requestId).toBe(request.id);

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_whatsapp_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe("in_app");
    expect(msgs[0].status).toBe("sent");
    expect(msgs[0].subject).toContain(`#${request.id}`);
    expect(msgs[0].subject?.toLowerCase()).toContain("whatsapp");
    expect(msgs[0].body).toContain(`#${request.id}`);
  });

  it("a second alert call for the same exhausted WhatsApp notice is a no-op", async () => {
    const request = await insertExhaustedWhatsappRequest();

    const first = await notifyAdminsOfRetryExhaustion({ channel: "whatsapp", request });
    expect(first.notified).toBe(true);

    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.whatsappExhaustionNotifiedAt).not.toBeNull();

    sendTransactionalPushMock.mockClear();

    const second = await notifyAdminsOfRetryExhaustion({
      channel: "whatsapp",
      request: stamped as MemberDataRequest,
    });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_whatsapp_exhausted"),
      eq(memberMessagesTable.relatedEntityId, request.id),
    ));
    expect(msgs).toHaveLength(1);
  });

  it("a fresh notifyDataRequest clears whatsappExhaustionNotifiedAt so a future exhaustion can re-alert", async () => {
    const request = await insertExhaustedWhatsappRequest();

    await notifyAdminsOfRetryExhaustion({ channel: "whatsapp", request });
    const [stamped] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(stamped.whatsappExhaustionNotifiedAt).not.toBeNull();

    await notifyDataRequest({
      organizationId: testOrgId,
      request: stamped as MemberDataRequest,
      kind: "in_progress",
    });

    const [afterFresh] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(afterFresh.whatsappExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.emailExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.pushExhaustionNotifiedAt).toBeNull();
    expect(afterFresh.smsExhaustionNotifiedAt).toBeNull();

    // Simulate the channel hitting the cap again so a follow-up alert is allowed.
    await db.update(memberDataRequestsTable).set({
      lastWhatsappStatus: "failed",
      whatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
      lastWhatsappError: "msg91 422 invalid_template",
      whatsappRetryExhaustedAt: new Date(),
    }).where(eq(memberDataRequestsTable.id, request.id));
    const [requeued] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));

    sendTransactionalPushMock.mockClear();
    const replay = await notifyAdminsOfRetryExhaustion({
      channel: "whatsapp",
      request: requeued as MemberDataRequest,
    });
    expect(replay.notified).toBe(true);
    expect(replay.recipients).toBeGreaterThan(0);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Provider-not-configured graceful skip ───────────────────────────────

describe("WhatsApp provider-not-configured graceful skip", () => {
  it("notifyDataRequest records 'skipped' when WHATSAPP_PROVIDER is not configured", async () => {
    await setWhatsappOptIn(true);
    const request = await insertFreshRequest();

    sendTransactionalWhatsappMock.mockImplementation(async () => {
      throw new Error("WHATSAPP_PROVIDER not configured. Set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio with required credentials.");
    });

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request,
      kind: "filed",
    });

    expect(result.whatsappStatus).toBe("skipped");
    expect(result.whatsappError).toBe("provider_not_configured");

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, request.id));
    expect(reloaded.lastWhatsappStatus).toBe("skipped");
    expect(reloaded.lastWhatsappError).toBe("provider_not_configured");
    // A skipped (non-failed) outcome must NOT increment whatsappAttempts —
    // the cron only retries `failed` rows, and a permanently-unconfigured
    // provider would otherwise eat the per-request retry budget on a single
    // call.
    expect(reloaded.whatsappAttempts).toBe(0);
    expect(reloaded.whatsappRetryExhaustedAt).toBeNull();
  });

  it("retryDataRequestWhatsapp returns a terminal 'skipped' result and stops re-selecting the row", async () => {
    await setWhatsappOptIn(true);
    const now = new Date();
    const [seed] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: now,
      dueBy: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      lastNotificationKind: "filed",
      lastNotifiedAt: now,
      lastWhatsappStatus: "failed",
      lastWhatsappAt: now,
      lastWhatsappError: "previous transient error",
      whatsappAttempts: 2,
    }).returning();
    createdRequestIds.push(seed.id);

    sendTransactionalWhatsappMock.mockImplementation(async () => {
      throw new Error("WHATSAPP_PROVIDER not configured. Set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio with required credentials.");
    });

    const result = await retryDataRequestWhatsapp({ request: seed as MemberDataRequest });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.error).toBe("provider_not_configured");
    // Attempt counter is intentionally NOT incremented on a provider-unconfigured
    // skip — it isn't a real delivery attempt.
    expect(result!.attempts).toBe(2);
    expect(result!.exhausted).toBe(false);

    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, seed.id));
    expect(reloaded.lastWhatsappStatus).toBe("skipped");
    expect(reloaded.lastWhatsappError).toBe("provider_not_configured");
    expect(reloaded.whatsappAttempts).toBe(2);
    expect(reloaded.whatsappRetryExhaustedAt).toBeNull();

    // Now the cron's status='failed' filter no longer matches, so the helper
    // refuses to retry this row.
    sendTransactionalWhatsappMock.mockClear();
    const noOp = await retryDataRequestWhatsapp({ request: reloaded as MemberDataRequest });
    expect(noOp).toBeNull();
    expect(sendTransactionalWhatsappMock).not.toHaveBeenCalled();
  });
});
