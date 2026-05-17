/**
 * Integration tests: member-facing WhatsApp opt-in toggle (Task #511).
 *
 * The mobile and web member preference screens expose a per-category WhatsApp
 * toggle that writes to memberCommPrefsTable.whatsappEnabled via the portal
 * `/api/portal/my-comm-prefs` endpoints. This suite locks in:
 *
 *   1. PUT /api/portal/my-comm-prefs persists `whatsappEnabled` (insert path)
 *      and a subsequent PUT for the same category updates it (upsert path).
 *   2. GET /api/portal/my-comm-prefs returns the persisted `whatsappEnabled`
 *      value so the client can render the switch in the correct state.
 *   3. A member with no member_comm_prefs row defaults to whatsappEnabled=false
 *      (privacy-safe: WhatsApp must be explicitly opted into).
 *   4. Flipping the `privacy.whatsappEnabled` toggle on/off actually changes
 *      which channels the privacy-notice sender (`notifyDataRequest`) uses:
 *      OFF → `sendTransactionalWhatsapp` is NOT called (status `opted_out`),
 *      ON  → `sendTransactionalWhatsapp` IS called (status `sent`).
 *
 * `comms` and `mailer` are mocked so privacy-notice fan-out is observable as
 * side-effects rather than real network traffic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const {
  sendTransactionalPushMock,
  sendTransactionalSmsMock,
  sendTransactionalWhatsappMock,
  sendDataRequestEmailMock,
} = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSmsMock: vi.fn(async () => undefined),
  sendTransactionalWhatsappMock: vi.fn(
    async (_phone: string, _body: string) => "wa-msgid-test",
  ),
  sendDataRequestEmailMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
  sendTransactionalWhatsapp: sendTransactionalWhatsappMock,
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));
vi.mock("../lib/mailer.js", () => ({
  sendDataRequestEmail: sendDataRequestEmailMock,
  sendDataRequestHandlerAssignedEmail: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberDataRequestsTable,
  memberMessagesTable,
  type MemberDataRequest,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { notifyDataRequest } from "../lib/dataRequestNotify.js";
import { createTestApp, type TestUser, uid } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text, body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz, error_message text,
      related_entity text, related_entity_id integer
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz, resolved_at timestamptz, notes text, artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      last_notification_kind text, last_notified_at timestamptz,
      last_email_status text, last_email_at timestamptz, last_email_error text,
      last_in_app_message_id integer REFERENCES member_messages(id) ON DELETE SET NULL,
      last_in_app_at timestamptz
    )`);
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
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_message_id text`,
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
      quiet_hours_start text, quiet_hours_end text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`ALTER TABLE member_comm_prefs ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false`);
}

let testOrgId: number;
let testUserId: number;
let testMemberId: number;
let testUser: TestUser;
const createdRequestIds: number[] = [];

beforeAll(async () => {
  await ensureSchema();
  const tag = uid("waToggle");

  const [org] = await db.insert(organizationsTable).values({
    name: `WaToggleOrg_${tag}`,
    slug: `wa-toggle-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wa-toggle-${tag}`,
    username: `wa_toggle_${tag}`,
    email: `${tag}@test.local`,
    displayName: "WhatsApp Toggle Member",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;
  testUser = { id: u.id, username: `wa_toggle_${tag}`, role: "player", organizationId: testOrgId };

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    firstName: "Toggle",
    lastName: "Tester",
    email: `${tag}-m@test.local`,
    phone: "+15555550199",
  }).returning({ id: clubMembersTable.id });
  testMemberId = m.id;
});

afterAll(async () => {
  if (createdRequestIds.length) {
    await db.delete(memberDataRequestsTable).where(inArray(memberDataRequestsTable.id, createdRequestIds));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, testMemberId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendTransactionalWhatsappMock.mockClear();
  sendTransactionalWhatsappMock.mockImplementation(async () => "wa-msgid-test");
  sendDataRequestEmailMock.mockClear();
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, testMemberId));
});

describe("GET /api/portal/my-comm-prefs — defaults & round-trip", () => {
  it("returns an empty array when the member has no member_comm_prefs rows", async () => {
    const app = createTestApp(testUser);
    const res = await request(app).get("/api/portal/my-comm-prefs").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns the persisted whatsappEnabled value after a PUT", async () => {
    const app = createTestApp(testUser);

    // Member opts in to WhatsApp for the billing category.
    await request(app).put("/api/portal/my-comm-prefs").send({
      category: "billing",
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: true,
      whatsappEnabled: true,
      inAppEnabled: true,
    }).expect(200);

    const res = await request(app).get("/api/portal/my-comm-prefs").expect(200);
    const billing = res.body.find((r: { category: string }) => r.category === "billing");
    expect(billing).toBeTruthy();
    expect(billing.whatsappEnabled).toBe(true);
    expect(billing.emailEnabled).toBe(true);
    expect(billing.pushEnabled).toBe(true);
    expect(billing.smsEnabled).toBe(false);
  });
});

describe("PUT /api/portal/my-comm-prefs — persists whatsappEnabled", () => {
  it("inserts a new row with whatsappEnabled=true on first PUT", async () => {
    const app = createTestApp(testUser);

    const res = await request(app).put("/api/portal/my-comm-prefs").send({
      category: "marketing",
      emailEnabled: false,
      smsEnabled: false,
      pushEnabled: false,
      whatsappEnabled: true,
      inAppEnabled: true,
    }).expect(200);

    expect(res.body).toBeTruthy();
    expect(res.body.category).toBe("marketing");
    expect(res.body.whatsappEnabled).toBe(true);

    const [row] = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, testMemberId),
      eq(memberCommPrefsTable.category, "marketing"),
    ));
    expect(row).toBeTruthy();
    expect(row.whatsappEnabled).toBe(true);
  });

  it("upserts: a second PUT for the same category flips whatsappEnabled back to false", async () => {
    const app = createTestApp(testUser);

    // First PUT: opt in.
    await request(app).put("/api/portal/my-comm-prefs").send({
      category: "events",
      emailEnabled: true, smsEnabled: false, pushEnabled: true,
      whatsappEnabled: true, inAppEnabled: true,
    }).expect(200);

    let rows = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, testMemberId),
      eq(memberCommPrefsTable.category, "events"),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].whatsappEnabled).toBe(true);
    const firstId = rows[0].id;

    // Second PUT: opt back out — should UPDATE, not INSERT a duplicate row.
    await request(app).put("/api/portal/my-comm-prefs").send({
      category: "events",
      emailEnabled: true, smsEnabled: false, pushEnabled: true,
      whatsappEnabled: false, inAppEnabled: true,
    }).expect(200);

    rows = await db.select().from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, testMemberId),
      eq(memberCommPrefsTable.category, "events"),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
    expect(rows[0].whatsappEnabled).toBe(false);
  });

  it("rejects unknown categories", async () => {
    const app = createTestApp(testUser);
    const res = await request(app).put("/api/portal/my-comm-prefs").send({
      category: "not-a-real-category",
      whatsappEnabled: true,
    }).expect(400);
    expect(String(res.body.error ?? "")).toMatch(/Invalid category/i);
  });
});

describe("Default behavior — no member_comm_prefs row means whatsappEnabled=false", () => {
  it("a member with no prefs row has no `privacy` whatsapp opt-in (notifyDataRequest skips WhatsApp)", async () => {
    // Sanity: there is no prefs row for this member at the start of the test.
    const existing = await db.select().from(memberCommPrefsTable)
      .where(eq(memberCommPrefsTable.clubMemberId, testMemberId));
    expect(existing).toHaveLength(0);

    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: new Date(),
      dueBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(row.id);

    const result = await notifyDataRequest({
      organizationId: testOrgId,
      request: row as MemberDataRequest,
      kind: "filed",
    });

    expect(result.whatsappStatus).toBe("opted_out");
    expect(sendTransactionalWhatsappMock).not.toHaveBeenCalled();
  });
});

describe("Toggling the privacy WhatsApp switch changes the privacy notice sender's channels", () => {
  it("OFF: privacy notice sender skips WhatsApp; ON: sender invokes WhatsApp", async () => {
    const app = createTestApp(testUser);

    // Step 1 — member opts OUT of WhatsApp for the privacy category via the
    // same PUT endpoint the mobile/web toggle calls.
    await request(app).put("/api/portal/my-comm-prefs").send({
      category: "privacy",
      emailEnabled: true, smsEnabled: false, pushEnabled: false,
      whatsappEnabled: false, inAppEnabled: true,
    }).expect(200);

    const [optOutReq] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: new Date(),
      dueBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(optOutReq.id);

    const offResult = await notifyDataRequest({
      organizationId: testOrgId,
      request: optOutReq as MemberDataRequest,
      kind: "filed",
    });
    expect(offResult.whatsappStatus).toBe("opted_out");
    expect(sendTransactionalWhatsappMock).not.toHaveBeenCalled();

    // Step 2 — member toggles WhatsApp ON via the same PUT endpoint.
    sendTransactionalWhatsappMock.mockClear();
    await request(app).put("/api/portal/my-comm-prefs").send({
      category: "privacy",
      emailEnabled: true, smsEnabled: false, pushEnabled: false,
      whatsappEnabled: true, inAppEnabled: true,
    }).expect(200);

    const [optInReq] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "in_progress",
      requestedAt: new Date(),
      dueBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    createdRequestIds.push(optInReq.id);

    const onResult = await notifyDataRequest({
      organizationId: testOrgId,
      request: optInReq as MemberDataRequest,
      kind: "filed",
    });
    expect(onResult.whatsappStatus).toBe("sent");
    expect(sendTransactionalWhatsappMock).toHaveBeenCalledTimes(1);
    // The body sent to WhatsApp must be the privacy notice subject + body.
    const [phone, body] = sendTransactionalWhatsappMock.mock.calls[0]!;
    expect(phone).toBe("+15555550199");
    expect(String(body)).toMatch(/Privacy request received/i);
  });
});
