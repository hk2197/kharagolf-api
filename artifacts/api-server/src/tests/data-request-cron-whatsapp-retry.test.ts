/**
 * Integration test: privacy WhatsApp retry — cron loop wiring (Task #509).
 *
 * Task #349 covers the unit-level WhatsApp privacy notice helpers
 * (`notifyDataRequest`, `retryDataRequestWhatsapp`,
 * `notifyAdminsOfRetryExhaustion`) in `data-request-whatsapp-exhaustion.test.ts`,
 * and `data-request-cron-retry-audit.test.ts` covers the cron audit-trail
 * contract for all four channels in a single multi-channel pass. Neither suite
 * isolates the WhatsApp branch of the cron's data-request retry pass on its
 * own. A regression that, e.g. forgot to call `retryDataRequestWhatsapp` from
 * `retryFailedDataRequestPushSms`, dropped the cron audit row for the
 * `whatsapp` channel, or skipped the `notifyAdminsOfRetryExhaustion` call on
 * cap exhaustion — but kept the email/push/SMS branches healthy — would still
 * pass today because the multi-channel suite would only fail on its WhatsApp
 * sub-assertions and the helper-level suite never goes through the cron at
 * all.
 *
 * This suite seeds a privacy request whose **only** failed channel is
 * WhatsApp (one short of the cap so a single cron pass tips it over the
 * edge) and asserts the four cron-loop side-effects in one go:
 *   1. The cron picks the row up and invokes `retryDataRequestWhatsapp`
 *      (observable via `sendTransactionalWhatsapp` being called).
 *   2. A `data_request_notification` audit row is written with
 *      `metadata.source === "cron"` and the WhatsApp channel detail.
 *   3. The exhaustion path stamps `whatsappRetryExhaustedAt` and
 *      `whatsappExhaustionNotifiedAt` (proves the cron called
 *      `notifyAdminsOfRetryExhaustion({ channel: "whatsapp" })`).
 *   4. The admin-alert push fan-out goes out tagged
 *      `data_request_whatsapp_exhausted`.
 *
 * Comms / mailer providers are mocked so retries are observable side-effects
 * rather than real network calls.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `retryFailedDataRequestPushSms` sweeps `member_data_requests` GLOBALLY.
 * The api-server vitest suite shares a dev DB across files, so unscoped
 * `mock).toHaveBeenCalledTimes(N)` totals would flake the moment a
 * sibling privacy/data-request test leaves a matching candidate row in
 * place. We therefore filter every mock call by the test-owned phone /
 * adminUserId / requestId.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const {
  sendTransactionalPushMock,
  sendTransactionalSmsMock,
  sendTransactionalWhatsappMock,
  sendDataRequestEmailMock,
} = vi.hoisted(() => ({
  // Push is only used by the admin exhaustion fan-out in this suite — return
  // a successful delivery shape so the alert helper records `notified`.
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _payload?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
  sendTransactionalSmsMock: vi.fn(async () => undefined),
  // WhatsApp fails synchronously — exercises the failed-retry + exhaustion
  // branch of the cron's WhatsApp pass.
  sendTransactionalWhatsappMock: vi.fn(
    async (_phone: string, _body: string): Promise<string | undefined> => {
      throw new Error("msg91 503 service_unavailable");
    },
  ),
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
  clubMembersTable,
  memberCommPrefsTable,
  memberDataRequestsTable,
  memberMessagesTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { retryFailedDataRequestPushSms } from "../lib/cron.js";
import { DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS } from "../lib/dataRequestNotify.js";

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
      last_in_app_at timestamptz
    )
  `);
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
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_message_id text`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`,
    `ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS whatsapp_exhaustion_notified_at timestamptz`,
  ]) {
    await db.execute(sql.raw(ddl));
  }
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
  await db.execute(sql`ALTER TABLE member_comm_prefs ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false`);
}

let testOrgId: number;
let testMemberId: number;
let adminUserId: number;
let requestId: number;

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CronWhatsApp_${ts}`,
    slug: `test-cron-whatsapp-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Cron",
    lastName: "WhatsAppSubject",
    email: "cron-whatsapp-member@example.test",
    phone: "+15555550155",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  // Direct org_admin so the admin exhaustion fan-out has a recipient to
  // push to — proves the cron walked the alert path end-to-end.
  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `cron-whatsapp-admin-${ts}`,
    username: `cron_whatsapp_admin_${ts}`,
    email: `cron_whatsapp_admin_${ts}@example.com`,
    displayName: "Cron WhatsApp Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  // Opt the member into WhatsApp for the privacy category — without this
  // `retryDataRequestWhatsapp` would still attempt the send (it doesn't
  // re-check opt-in on retry), but seeding a realistic prefs row makes the
  // fixture consistent with how the row would have ended up in `failed`
  // state in production.
  await db.insert(memberCommPrefsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    category: "privacy",
    emailEnabled: false,
    smsEnabled: false,
    pushEnabled: false,
    whatsappEnabled: true,
  });

  // Seed a privacy request whose only failed channel is WhatsApp, one
  // attempt short of the cap so the cron's single pass tips it over the
  // edge into the exhaustion branch.
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
    lastWhatsappError: "msg91 503 service_unavailable",
    whatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS - 1,
  }).returning();
  requestId = row.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, testOrgId),
    eq(memberAuditLogTable.entity, "data_request_notification"),
  ));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, requestId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

describe("retryFailedDataRequestPushSms — WhatsApp branch wiring", () => {
  // Run the cron pass exactly once for the suite. All assertions below check
  // independent durable side-effects so neither depends on the other's
  // execution.
  beforeAll(async () => {
    sendTransactionalPushMock.mockClear();
    sendTransactionalWhatsappMock.mockClear();
    await retryFailedDataRequestPushSms();
  });

  it("invokes retryDataRequestWhatsapp for a WhatsApp-failed candidate", async () => {
    // Observable proof the cron picked the row up and walked into the
    // WhatsApp retry helper: the helper attempts a fresh provider send,
    // which is what `sendTransactionalWhatsapp` represents. Filter by
    // OUR seeded phone so a sibling test leaking a global candidate can't
    // inflate the count.
    const ourWaCalls = sendTransactionalWhatsappMock.mock.calls.filter(
      (c) => (c as [string, string])[0] === "+15555550155",
    );
    expect(ourWaCalls).toHaveLength(1);

    // The retry path must persist the bumped attempt counter and stamp the
    // exhaustion column when the cap is hit on this pass.
    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, requestId));
    expect(reloaded.whatsappAttempts).toBe(DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS);
    expect(reloaded.lastWhatsappStatus).toBe("failed");
    expect(reloaded.lastWhatsappError).toBe("msg91 503 service_unavailable");
    expect(reloaded.whatsappRetryExhaustedAt).not.toBeNull();
    expect(reloaded.lastWhatsappRetryAt).not.toBeNull();
  });

  it("writes a cron audit row tagged channel='whatsapp' with source='cron'", async () => {
    type AuditMeta = {
      kind?: string;
      source?: string;
      channels?: Record<string, { status: string; at: string; error: string | null }>;
    };

    const rows = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_request_notification"),
        eq(memberAuditLogTable.entityId, requestId),
        eq(memberAuditLogTable.action, "resend"),
      ));

    // Exactly one cron-emitted audit row — the WhatsApp branch — because no
    // other channel was eligible in this fixture.
    expect(rows).toHaveLength(1);
    const meta = (rows[0].metadata as AuditMeta | null) ?? {};
    expect(meta.source).toBe("cron");
    expect(meta.kind).toBe("filed");
    expect(meta.channels).toBeTruthy();
    expect(Object.keys(meta.channels ?? {})).toEqual(["whatsapp"]);

    const detail = meta.channels!.whatsapp;
    expect(detail.status).toBe("failed");
    expect(detail.error).toBe("msg91 503 service_unavailable");
    expect(typeof detail.at).toBe("string");
    expect(Number.isNaN(Date.parse(detail.at))).toBe(false);

    // The reason marker is the same shape the resend-history popover parses
    // for legacy fallback — `automatic <channel> retry` plus the exhaustion
    // tag when we tipped over the cap.
    expect(rows[0].reason ?? "").toContain("automatic whatsapp retry");
    expect(rows[0].reason ?? "").toContain("whatsapp:failed");
    expect(rows[0].reason ?? "").toContain("(exhausted)");
  });

  it("fires notifyAdminsOfRetryExhaustion({ channel: 'whatsapp' }) on cap exhaustion", async () => {
    // The dedup stamp on the request row is the durable proof that the cron
    // called into `notifyAdminsOfRetryExhaustion` for the WhatsApp channel —
    // the helper is the only path that writes this column. Sibling
    // exhaustion stamps must remain NULL because no other channel was
    // exercised in this fixture.
    const [reloaded] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, requestId));
    expect(reloaded.whatsappExhaustionNotifiedAt).not.toBeNull();
    expect(reloaded.emailExhaustionNotifiedAt).toBeNull();
    expect(reloaded.pushExhaustionNotifiedAt).toBeNull();
    expect(reloaded.smsExhaustionNotifiedAt).toBeNull();

    // Admin push fan-out: the alert helper pushes to every org admin (and
    // the assigned handler if present). Here that's just the one direct
    // org_admin we seeded, with the WhatsApp-tagged push payload. Filter
    // by OUR adminUserId so sibling tests leaking exhaustion notifications
    // for unrelated rows can't mask a regression here.
    const ourPushCalls = sendTransactionalPushMock.mock.calls.filter((c) => {
      const ids = c[0] as number[];
      return ids.includes(adminUserId);
    });
    expect(ourPushCalls).toHaveLength(1);
    const [recipients, title, , data] = ourPushCalls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(recipients).toEqual([adminUserId]);
    expect(title).toContain("WhatsApp");
    expect(data.type).toBe("data_request_whatsapp_exhausted");
    expect(data.requestId).toBe(requestId);

    // The in-app message that records the alert on the Member 360 timeline
    // is also a side-effect of `notifyAdminsOfRetryExhaustion`. Asserting on
    // its tag locks in the same channel attribution end-to-end.
    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "data_request_whatsapp_exhausted"),
      eq(memberMessagesTable.relatedEntityId, requestId),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe("in_app");
    expect(msgs[0].subject?.toLowerCase()).toContain("whatsapp");
  });
});
