/**
 * Integration tests: "Email members when their data export download is
 * about to expire" cron (Task #922).
 *
 * Self-serve data exports stay downloadable for `DATA_EXPORT_VALID_DAYS` (7)
 * days after `resolvedAt`. The reminder cron sends a friendly nudge ~24h
 * before that window closes, but only to members who:
 *   - still have a downloadable artifact (artifactUrl IS NOT NULL),
 *   - haven't grabbed it yet (artifactDownloadedAt IS NULL),
 *   - haven't already been nudged for this row (expiringNoticeSentAt IS NULL),
 *   - had the original "ready" notice fire (lastNotificationKind = 'completed_export').
 *
 * The notice itself flows through `notifyDataRequest({ kind:
 * "export_expiring" })` so we mock the mailer + comms in the same shape as
 * `portal-data-export-notify.test.ts` and assert the cron picks the right
 * rows + stamps `expiringNoticeSentAt` exactly once.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * The api-server vitest suite runs in a single fork against a shared
 * dev DB and `sendDataExportExpiringReminders` sweeps
 * `member_data_requests` globally. Unscoped `result.notified`/
 * `.suppressed` counters and `mailerMock.toHaveBeenCalledTimes(N)`
 * totals would flake the moment a sibling cron test leaks a matching
 * row, so this file scopes assertions to rows/recipients we own
 * (`testOrgId`, seeded `requestId`).
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

const SIGNED_URL = "https://storage.example.test/signed-data-export.json?token=expiring";
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
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, sql, and, isNotNull } from "drizzle-orm";
import { sendDataExportExpiringReminders } from "../lib/cron.js";

// Row-scoped helpers (Task #1808 / #2266) — count only rows owned by THIS test.
async function ourNotifiedRows() {
  return db.select().from(memberDataRequestsTable).where(and(
    eq(memberDataRequestsTable.organizationId, testOrgId),
    eq(memberDataRequestsTable.lastNotificationKind, "export_expiring"),
  ));
}
async function ourStampedRows() {
  return db.select().from(memberDataRequestsTable).where(and(
    eq(memberDataRequestsTable.organizationId, testOrgId),
    isNotNull(memberDataRequestsTable.expiringNoticeSentAt),
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
  // Task #922 — new columns the cron eligibility checks read/write.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS artifact_downloaded_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_notice_sent_at timestamptz`);
  // Defensive ALTERs for older test DBs.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS purged_at timestamptz`);
  // Task #1075 — per-request opt-out columns + global pref column.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_unsub_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_opted_out_at timestamptz`);
  // Wrapped in a savepoint so a race with the sibling test file doesn't blow up the suite.
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
    name: `TestOrg_ExportExpiring_${ts}`,
    slug: `test-export-expiring-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `export-expiring-${ts}`,
    username: `export_expiring_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Expire",
    lastName: "Reminder",
    email: `export-expiring-${ts}@example.test`,
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
    lastNotificationKind: "completed_export",
    lastNotifiedAt: new Date(Date.now() - 6 * DAY_MS),
    ...overrides,
  }).returning();
  return row;
}

describe("sendDataExportExpiringReminders", () => {
  it("nudges eligible rows once and stamps expiringNoticeSentAt", async () => {
    // Eligible: resolved 6.25 days ago — inside the [now-7d, now-6d] window.
    const eligible = await seed({ resolvedAt: new Date(Date.now() - 6.25 * DAY_MS) });

    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(1);

    // Email was dispatched with the new export_expiring kind + signed URL.
    const ourEmailCalls = emailCallsForRequest(eligible.id);
    expect(ourEmailCalls).toHaveLength(1);
    const call = ourEmailCalls[0]![0] as {
      kind: string; artifactUrl: string | null; requestId: number;
    };
    expect(call.kind).toBe("export_expiring");
    expect(call.requestId).toBe(eligible.id);
    expect(call.artifactUrl).toBe(SIGNED_URL);

    // Push fan-out fired with the same kind + signed URL in the payload.
    const ourPushCalls = pushCallsForUser(testUserId);
    expect(ourPushCalls).toHaveLength(1);
    const [, , , pushPayload] = ourPushCalls[0]! as [
      number[], string, string, Record<string, unknown>,
    ];
    expect(pushPayload.kind).toBe("export_expiring");
    expect(pushPayload.downloadUrl).toBe(SIGNED_URL);

    // Row was stamped + lastNotificationKind flipped — second pass is a no-op.
    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, eligible.id));
    expect(after.expiringNoticeSentAt).not.toBeNull();
    expect(after.lastNotificationKind).toBe("export_expiring");

    sendDataRequestEmailMock.mockClear();
    sendTransactionalPushMock.mockClear();
    await sendDataExportExpiringReminders();
    expect(emailCallsForRequest(eligible.id)).toHaveLength(0);
  });

  it("skips rows the member has already downloaded", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      artifactDownloadedAt: new Date(Date.now() - 1 * DAY_MS),
    });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows whose archive was already purged (artifactUrl IS NULL)", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      artifactUrl: null,
    });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows still well inside the validity window (too early to nudge)", async () => {
    const row = await seed({ resolvedAt: new Date(Date.now() - 2 * DAY_MS) });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows whose download link has already expired", async () => {
    const row = await seed({ resolvedAt: new Date(Date.now() - 8 * DAY_MS) });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows that were never marked as ready (lastNotificationKind != 'completed_export')", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      lastNotificationKind: "completed",
    });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  it("skips rows already nudged once (expiringNoticeSentAt set)", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      expiringNoticeSentAt: new Date(Date.now() - 1 * DAY_MS),
    });
    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);
  });

  // Task #1075 — opt-out path: per-request flag suppresses the reminder.
  it("suppresses (does not email) rows whose expiringReminderOptedOutAt is set", async () => {
    const row = await seed({
      resolvedAt: new Date(Date.now() - 6.25 * DAY_MS),
      expiringReminderOptedOutAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      expiringReminderUnsubToken: "test-per-request-opt-out-token",
    });

    await sendDataExportExpiringReminders();
    expect(await ourNotifiedRows()).toHaveLength(0);
    expect(emailCallsForRequest(row.id)).toHaveLength(0);

    // Row is stamped so subsequent passes skip it via the existing dedup guard.
    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.expiringNoticeSentAt).not.toBeNull();
    // Suppressed-but-stamped row is row-scoped via expiringNoticeSentAt.
    expect(await ourStampedRows()).toHaveLength(1);
  });

  // Task #1075 — opt-out path: global notification preference suppresses too.
  it("suppresses rows when the member has notifyDataExportExpiring=false globally", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId: testUserId, notifyDataExportExpiring: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyDataExportExpiring: false },
    });
    try {
      const row = await seed({ resolvedAt: new Date(Date.now() - 6.25 * DAY_MS) });
      await sendDataExportExpiringReminders();
      expect(await ourNotifiedRows()).toHaveLength(0);
      expect(emailCallsForRequest(row.id)).toHaveLength(0);
      // Suppressed row is stamped to skip on future passes.
      expect(await ourStampedRows()).toHaveLength(1);
    } finally {
      await db.delete(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, testUserId));
    }
  });
});
