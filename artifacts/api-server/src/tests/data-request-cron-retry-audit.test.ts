/**
 * Integration tests: System (cron) privacy retry audit trail (Task 317).
 *
 * Task 251 made the privacy retry cron emit a `data_request_notification`
 * audit row tagged `metadata.source = "cron"` with structured per-channel
 * metadata, and updated the resend-history endpoint to flag those rows as
 * `initiatedBy: "system"`. This suite locks that contract in so a future
 * refactor of `retryFailedDataRequestPushSms`, `recordCronRetryAudit`, or
 * the resend-history endpoint can't silently drop the system retry audit
 * trail or the "by system" badge.
 *
 * Coverage:
 *   1. End-to-end cron pass — for each retried channel an audit row is
 *      created with `metadata.source === "cron"`, the right channel under
 *      `metadata.channels`, and a timestamp + provider error captured.
 *   2. Failed retries record `error` + the `(exhausted)` reason marker
 *      when the per-channel cap is hit; successful retries record the
 *      success status with a null error.
 *   3. The `/resend-history` endpoint marks each cron-emitted row as
 *      `initiatedBy: "system"`.
 *
 * Comms / mailer providers are mocked so retries are observable side-effects
 * rather than real network calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const {
  sendTransactionalPushMock,
  sendTransactionalSmsMock,
  sendTransactionalWhatsappMock,
  sendDataRequestEmailMock,
} = vi.hoisted(() => ({
  // Push succeeds — we want one cron row that captures a successful retry.
  sendTransactionalPushMock: vi.fn(async () => ({
    attempted: 1, sent: 1, failed: 0, invalid: 0,
  })),
  // SMS fails synchronously — exercises the failed-retry audit branch.
  sendTransactionalSmsMock: vi.fn(async () => {
    throw new Error("twilio 21610 unsubscribed");
  }),
  // WhatsApp fails synchronously — same path as SMS.
  sendTransactionalWhatsappMock: vi.fn(async () => {
    throw new Error("whatsapp_template_rejected");
  }),
  // Email fails synchronously — exercises the failed-retry audit branch.
  sendDataRequestEmailMock: vi.fn(async () => {
    throw new Error("smtp 421 try later");
  }),
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
  clubMembersTable,
  memberDataRequestsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { retryFailedDataRequestPushSms } from "../lib/cron.js";
import {
  DATA_REQUEST_MAX_PUSH_ATTEMPTS,
  DATA_REQUEST_MAX_SMS_ATTEMPTS,
  DATA_REQUEST_MAX_EMAIL_ATTEMPTS,
  DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
} from "../lib/dataRequestNotify.js";
import { createTestApp, type TestUser } from "./helpers.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────
//
// Mirrors the bootstrap in the other privacy/data-request suites so this
// test runs in environments where the privacy/comm tables haven't been
// pushed via drizzle-kit yet.
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
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_status text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_error text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_exhaustion_notified_at timestamptz`);
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

let testOrgId: number;
let testMemberId: number;
let testMemberUserId: number;
let adminUserId: number;
let admin: TestUser;
let requestId: number;

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CronAudit_${ts}`,
    slug: `test-cron-audit-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // Member-owned user account so push delivery has a userId target.
  const [memberUser] = await db.insert(appUsersTable).values({
    replitUserId: `cron-audit-member-${ts}`,
    username: `cron_audit_member_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testMemberUserId = memberUser.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Cron",
    lastName: "Subject",
    email: "cron-audit-member@example.test",
    phone: "+15555550110",
    userId: testMemberUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `cron-audit-admin-${ts}`,
    username: `cron_audit_admin_${ts}`,
    email: `cron_audit_admin_${ts}@example.com`,
    displayName: "Cron Audit Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;
  admin = {
    id: adminUserId,
    username: `cron_audit_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  };

  // Insert a privacy request whose four channels are all in `failed` state
  // with attempt counters one short of their caps so a single cron pass:
  //   - email retries → fails again → exhausts
  //   - push retries → succeeds (mock returns sent:1)
  //   - sms retries → fails again → exhausts
  //   - whatsapp retries → fails again → exhausts
  // That gives us one audit row per channel with both the success and
  // failure branches of `recordCronRetryAudit` exercised.
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
    lastEmailError: "smtp 421 try later",
    emailAttempts: DATA_REQUEST_MAX_EMAIL_ATTEMPTS - 1,
    lastPushStatus: "failed",
    lastPushAt: now,
    lastPushError: "push_delivery_failed",
    pushAttempts: 1,
    lastSmsStatus: "failed",
    lastSmsAt: now,
    lastSmsError: "twilio 21610 unsubscribed",
    smsAttempts: DATA_REQUEST_MAX_SMS_ATTEMPTS - 1,
    lastWhatsappStatus: "failed",
    lastWhatsappAt: now,
    lastWhatsappError: "whatsapp_template_rejected",
    whatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS - 1,
  }).returning();
  requestId = row.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, testOrgId),
    eq(memberAuditLogTable.entity, "data_request_notification"),
  ));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, requestId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testMemberUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockClear();
  sendTransactionalSmsMock.mockClear();
  sendTransactionalWhatsappMock.mockClear();
  sendDataRequestEmailMock.mockClear();
});

describe("retryFailedDataRequestPushSms — system retry audit trail", () => {
  // Run the cron pass exactly once for the suite. Both tests below assert
  // independently on the durable side-effects (audit rows + resend-history
  // payload) so neither depends on the other's execution.
  beforeAll(async () => {
    await retryFailedDataRequestPushSms();
  });

  it("emits one audit row per retried channel tagged source=cron with structured per-channel metadata", async () => {
    const rows = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_request_notification"),
        eq(memberAuditLogTable.entityId, requestId),
        eq(memberAuditLogTable.action, "resend"),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));

    // One audit row per channel: email, push, sms, whatsapp.
    expect(rows).toHaveLength(4);

    type AuditMeta = {
      kind?: string;
      source?: string;
      channels?: Record<string, { status: string; at: string; error: string | null }>;
    };

    const byChannel = new Map<string, { row: typeof rows[number]; meta: AuditMeta }>();
    for (const r of rows) {
      const meta = (r.metadata as AuditMeta | null) ?? {};
      // Every system-retry row must carry the cron tag.
      expect(meta.source).toBe("cron");
      // The original notification kind is preserved so the popover can group
      // the retry under the same notice.
      expect(meta.kind).toBe("filed");
      expect(meta.channels).toBeTruthy();
      const channelKeys = Object.keys(meta.channels ?? {});
      expect(channelKeys).toHaveLength(1);
      byChannel.set(channelKeys[0], { row: r, meta });
    }

    expect(new Set(byChannel.keys())).toEqual(new Set(["email", "push", "sms", "whatsapp"]));

    // Email retry: fails (smtp 421 try later), and lands on the cap so the
    // reason marker includes `(exhausted)`.
    const email = byChannel.get("email")!;
    const emailDetail = email.meta.channels!.email;
    expect(emailDetail.status).toBe("failed");
    expect(emailDetail.error).toBe("smtp 421 try later");
    // ISO-8601 timestamp captured at retry time.
    expect(typeof emailDetail.at).toBe("string");
    expect(Number.isNaN(Date.parse(emailDetail.at))).toBe(false);
    expect(email.row.reason ?? "").toContain("automatic email retry");
    expect(email.row.reason ?? "").toContain("email:failed");
    expect(email.row.reason ?? "").toContain("(exhausted)");

    // Push retry: succeeds (mock returns sent:1) — null error and `sent` status.
    const push = byChannel.get("push")!;
    const pushDetail = push.meta.channels!.push;
    expect(pushDetail.status).toBe("sent");
    expect(pushDetail.error).toBeNull();
    expect(typeof pushDetail.at).toBe("string");
    expect(push.row.reason ?? "").toContain("automatic push retry");
    expect(push.row.reason ?? "").toContain("push:sent");
    expect(push.row.reason ?? "").not.toContain("(exhausted)");

    // SMS retry: fails (twilio 21610) and exhausts the cap.
    const sms = byChannel.get("sms")!;
    const smsDetail = sms.meta.channels!.sms;
    expect(smsDetail.status).toBe("failed");
    expect(smsDetail.error).toBe("twilio 21610 unsubscribed");
    expect(typeof smsDetail.at).toBe("string");
    expect(sms.row.reason ?? "").toContain("automatic sms retry");
    expect(sms.row.reason ?? "").toContain("sms:failed");
    expect(sms.row.reason ?? "").toContain("(exhausted)");

    // WhatsApp retry: fails and exhausts the cap.
    const wa = byChannel.get("whatsapp")!;
    const waDetail = wa.meta.channels!.whatsapp;
    expect(waDetail.status).toBe("failed");
    expect(waDetail.error).toBe("whatsapp_template_rejected");
    expect(typeof waDetail.at).toBe("string");
    expect(wa.row.reason ?? "").toContain("automatic whatsapp retry");
    expect(wa.row.reason ?? "").toContain("whatsapp:failed");
    expect(wa.row.reason ?? "").toContain("(exhausted)");

    // (The provider mocks themselves are not asserted on here because the
    // cron pass runs once in beforeAll and the global beforeEach clears
    // the call history — the assertions above on the persisted audit
    // metadata are the authoritative proof that each channel was retried.)
  });

  it("the resend-history endpoint marks every cron-emitted row as initiatedBy=system with the right per-channel detail", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/members-360/${testMemberId}/data-requests/${requestId}/resend-history`)
      .expect(200);

    type HistoryEntry = {
      id: number;
      initiatedBy: "system" | "admin" | "member";
      reason: string | null;
      channels: Record<"email" | "inApp" | "push" | "sms", { status: string; at: string | null; error: string | null } | null>;
    };
    const body = res.body as { count: number; history: HistoryEntry[] };

    expect(body.count).toBe(4);
    expect(body.history).toHaveLength(4);

    // Every entry from the cron pass must surface as system-initiated. Other
    // initiator buckets must be empty so the "By system" tab in the popover
    // only shows these rows.
    for (const entry of body.history) {
      expect(entry.initiatedBy).toBe("system");
    }
    expect(body.history.filter(h => h.initiatedBy === "admin")).toHaveLength(0);
    expect(body.history.filter(h => h.initiatedBy === "member")).toHaveLength(0);

    // The endpoint maps `metadata.channels.{push,sms,email}` straight through
    // and (legacy-)parses the reason string for any extra channel hints. We
    // expect at minimum the targeted channel of each row to come through.
    const pushRow = body.history.find(h => (h.reason ?? "").includes("automatic push retry"));
    expect(pushRow?.channels.push?.status).toBe("sent");
    expect(pushRow?.channels.push?.error).toBeNull();
    expect(pushRow?.channels.push?.at).toBeTruthy();

    const smsRow = body.history.find(h => (h.reason ?? "").includes("automatic sms retry"));
    expect(smsRow?.channels.sms?.status).toBe("failed");
    expect(smsRow?.channels.sms?.error).toBe("twilio 21610 unsubscribed");
    expect(smsRow?.channels.sms?.at).toBeTruthy();

    const emailRow = body.history.find(h => (h.reason ?? "").includes("automatic email retry"));
    expect(emailRow?.channels.email?.status).toBe("failed");
    expect(emailRow?.channels.email?.error).toBe("smtp 421 try later");
    expect(emailRow?.channels.email?.at).toBeTruthy();
  });
});
