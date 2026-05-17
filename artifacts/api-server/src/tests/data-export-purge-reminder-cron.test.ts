/**
 * Integration tests: "Email members a heads-up the day before their export
 * auto-deletes" cron (Task #972).
 *
 * Self-serve data exports stay downloadable for `DATA_EXPORT_VALID_DAYS` (7)
 * days after `resolvedAt`; the daily purger then deletes the archive. This
 * cron sends a courtesy notice ~24h before that purge so members can grab
 * the file before it disappears, but only to members who:
 *   - still have a downloadable artifact (artifactUrl IS NOT NULL),
 *   - haven't grabbed it yet (artifactDownloadedAt IS NULL),
 *   - haven't already been nudged by this cron (expiryNotifiedAt IS NULL),
 *   - haven't already been nudged by the Task #922 sibling
 *     (expiringNoticeSentAt IS NULL).
 *
 * Unlike the Task #922 sibling this cron does NOT gate on
 * lastNotificationKind = 'completed_export', so it covers access exports
 * whose most recent privacy-notice was overwritten (e.g. by a manual
 * `completed` re-send).
 *
 * The notice itself flows through `notifyDataRequest({ kind:
 * "export_expiring" })` so we mock the mailer + comms in the same shape as
 * the sibling test.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * The api-server vitest suite runs in a single fork against a shared
 * dev DB and `sendDataExportPurgeReminders` sweeps
 * `member_data_requests` globally. Unscoped `result.notified` /
 * `mailerMock.toHaveBeenCalledTimes(N)` totals would flake the moment a
 * sibling cron test leaks a matching row, so this file scopes
 * assertions to rows/recipients we own (`testOrgId`, seeded `requestId`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendDataRequestEmailMock, sendTransactionalPushMock } = vi.hoisted(() => ({
  sendDataRequestEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
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
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return { ...actual, sendDataRequestEmail: sendDataRequestEmailMock };
});

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => "wa_msg_id"),
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

const SIGNED_URL = "https://storage.example.test/signed-data-export.json?token=purge";
vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(relativePath: string): Promise<string> { return `/objects/${relativePath}`; }
    async getSignedDownloadUrl(): Promise<string> { return SIGNED_URL; }
    async getObjectEntityFile(): Promise<never> { throw new Error("not used in this test"); }
  },
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberMessagesTable,
} from "@workspace/db";
import { eq, sql, and, isNotNull } from "drizzle-orm";
import { sendDataExportPurgeReminders } from "../lib/cron.js";

// Row-scoped helpers (Task #1808 / #2266) — count only rows owned by THIS test.
async function ourNotifiedRows() {
  return db.select().from(memberDataRequestsTable).where(and(
    eq(memberDataRequestsTable.organizationId, testOrgId),
    isNotNull(memberDataRequestsTable.expiryNotifiedAt),
  ));
}
function emailCallsForRequest(requestId: number) {
  return sendDataRequestEmailMock.mock.calls.filter(c =>
    (c[0] as { requestId?: number }).requestId === requestId,
  );
}
function pushCallsForUser(userId: number) {
  return sendTransactionalPushMock.mock.calls.filter(c =>
    (c[0] as number[]).includes(userId),
  );
}

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
      last_in_app_at timestamptz,
      last_push_status text, last_push_at timestamptz, last_push_error text,
      last_sms_status text, last_sms_at timestamptz, last_sms_error text,
      last_whatsapp_status text, last_whatsapp_at timestamptz, last_whatsapp_error text,
      last_whatsapp_message_id text,
      push_attempts integer NOT NULL DEFAULT 0, sms_attempts integer NOT NULL DEFAULT 0,
      whatsapp_attempts integer NOT NULL DEFAULT 0,
      last_push_retry_at timestamptz, last_sms_retry_at timestamptz,
      last_whatsapp_retry_at timestamptz,
      push_retry_exhausted_at timestamptz, sms_retry_exhausted_at timestamptz,
      whatsapp_retry_exhausted_at timestamptz,
      email_attempts integer NOT NULL DEFAULT 0,
      last_email_retry_at timestamptz, email_retry_exhausted_at timestamptz,
      email_exhaustion_notified_at timestamptz,
      push_exhaustion_notified_at timestamptz,
      sms_exhaustion_notified_at timestamptz,
      whatsapp_exhaustion_notified_at timestamptz,
      purged_at timestamptz
    )`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS artifact_downloaded_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_notice_sent_at timestamptz`);
  // Task #972 — new dedup column the purge-reminder cron reads/writes.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiry_notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS purged_at timestamptz`);
  // Task #1075 — opt-out columns + global pref column.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_unsub_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_opted_out_at timestamptz`);
  // Wrapped so a race with the sibling test file doesn't blow up the suite.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS member_data_requests_expiring_reminder_unsub_token_idx ON member_data_requests(expiring_reminder_unsub_token)`);
  } catch {/* concurrent CREATE INDEX from sibling test — already exists */}
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_data_export_expiring boolean NOT NULL DEFAULT true`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text, actor_role text,
      entity text NOT NULL, entity_id integer, action text NOT NULL,
      field_changes jsonb, reason text, metadata jsonb,
      ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

let testOrgId: number;
let testMemberId: number;
let testUserId: number;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PurgeReminder_${ts}`,
    slug: `test-purge-reminder-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `purge-reminder-${ts}`,
    username: `purge_reminder_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Purge",
    lastName: "Reminder",
    email: `purge-reminder-${ts}@example.test`,
    userId: testUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;
});

afterAll(async () => {
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  sendDataRequestEmailMock.mockClear();
  sendTransactionalPushMock.mockClear();
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(overrides: Partial<typeof memberDataRequestsTable.$inferInsert>) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "completed",
    requestedAt: new Date(),
    artifactUrl: "/objects/exports/test-archive.json",
    // Intentionally a *different* lastNotificationKind to prove this cron
    // is broader than the Task #922 sibling (which gates on completed_export).
    lastNotificationKind: "completed",
    lastNotifiedAt: new Date(Date.now() - 6 * DAY_MS),
    ...overrides,
  }).returning();
  return row;
}

describe("sendDataExportPurgeReminders", () => {
  it("nudges eligible rows once and stamps both dedup columns", async () => {
    const eligible = await seed({ resolvedAt: new Date(Date.now() - 6.25 * DAY_MS) });

    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(1);

    const ourEmailCalls = emailCallsForRequest(eligible.id);
    expect(ourEmailCalls).toHaveLength(1);
    const call = ourEmailCalls[0]![0] as {
      kind: string; requestId: number;
    };
    expect(call.kind).toBe("export_expiring");
    expect(call.requestId).toBe(eligible.id);

    expect(pushCallsForUser(testUserId)).toHaveLength(1);

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, eligible.id));
    expect(after.expiryNotifiedAt).not.toBeNull();
    // Also stamps the sibling column so the two crons never double-nudge.
    expect(after.expiringNoticeSentAt).not.toBeNull();

    sendDataRequestEmailMock.mockClear();
    sendTransactionalPushMock.mockClear();
    await sendDataExportPurgeReminders();
    expect(emailCallsForRequest(eligible.id)).toHaveLength(0);
  });

  it("skips rows the member has already downloaded", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      artifactDownloadedAt: new Date(Date.now() - 1 * DAY_MS),
    });
    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows whose archive was already purged (artifactUrl IS NULL)", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      artifactUrl: null,
    });
    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows still well inside the validity window (too early to nudge)", async () => {
    const row = await seed({ resolvedAt: new Date(Date.now() - 2 * DAY_MS) });
    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows whose archive has already been auto-deleted", async () => {
    const row = await seed({ resolvedAt: new Date(Date.now() - 8 * DAY_MS) });
    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows already nudged by this cron (expiryNotifiedAt set)", async () => {
    // Pre-stamped row counts as "ourNotifiedRows" so we use a snapshot delta.
    const before = (await ourNotifiedRows()).length;
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      expiryNotifiedAt: new Date(Date.now() - 1 * DAY_MS),
    });
    await sendDataExportPurgeReminders();
    // No new email goes out for our row; the seeded stamp is preserved.
    expect((await ourNotifiedRows()).length).toBe(before + 1);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows already nudged by the Task #922 sibling cron", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      expiringNoticeSentAt: new Date(Date.now() - 1 * DAY_MS),
    });
    await sendDataExportPurgeReminders();
    // The sibling cron stamped expiringNoticeSentAt but NOT expiryNotifiedAt;
    // this cron must leave expiryNotifiedAt null for our row.
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("nudges access exports regardless of lastNotificationKind", async () => {
    // Default seed uses lastNotificationKind = 'completed' (NOT
    // completed_export). The Task #922 sibling would skip this row; this
    // cron must still cover it.
    const eligible = await seed({ resolvedAt: new Date(Date.now() - 6.25 * DAY_MS) });
    await sendDataExportPurgeReminders();
    expect(await ourNotifiedRows()).toHaveLength(1);
    expect(emailCallsForRequest(eligible.id)).toHaveLength(1);
  });
});
