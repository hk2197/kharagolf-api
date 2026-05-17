/**
 * Integration tests: Levy-receipt push/SMS exhaustion admin alert (Task #269).
 *
 * Task #269 added an in-app + push admin alert that fires once per channel
 * when the levy-receipt retry cron stamps `pushRetryExhaustedAt` /
 * `smsRetryExhaustedAt` on a `member_levy_receipt_attempts` row. This suite
 * exercises the alert end-to-end through the cron entry point so a future
 * regression doesn't silently stop alerting finance/admin staff.
 *
 * Locks in:
 *   1. Push channel — running `retryFailedLevyReceiptPushSms` against a row
 *      one attempt away from the cap (with a stubbed push provider that
 *      always fails) stamps `pushExhaustionNotifiedAt`, inserts an in-app
 *      message tagged `levy_receipt_push_exhausted` referencing the attempts
 *      row, and pushes the alert to org admins.
 *   2. SMS channel — same behaviour for SMS, with the message tagged
 *      `levy_receipt_sms_exhausted`.
 *   3. Dedup — a second cron pass on the same row does NOT re-notify (the
 *      row is past the cap and the dedup stamp also blocks a direct call to
 *      `notifyAdminsOfLevyReceiptRetryExhaustion`).
 *
 * `comms` is mocked so push/SMS calls are observable side-effects rather than
 * real network calls. The push mock differentiates between the per-member
 * receipt retry (forced to fail) and the admin alert push (allowed to
 * succeed) by inspecting the `data.type` payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendTransactionalPushMock, sendTransactionalSmsMock, sendTransactionalWhatsappMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(),
  sendTransactionalSmsMock: vi.fn(),
  sendTransactionalWhatsappMock: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: sendTransactionalPushMock,
  sendTransactionalSms: sendTransactionalSmsMock,
  sendTransactionalWhatsapp: sendTransactionalWhatsappMock,
  sendBroadcast: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyReceiptAttemptsTable,
  memberMessagesTable,
  type MemberLevyReceiptAttempt,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { retryFailedLevyReceiptPushSms } from "../lib/cron.js";
import { notifyAdminsOfLevyReceiptRetryExhaustion } from "../lib/levyReceiptNotify.js";

// ── Schema bootstrap ──────────────────────────────────────────────────────
//
// The test database may lag behind the latest Drizzle schema for the levy
// receipt tables. Bootstrap the small subset of schema this test needs with
// idempotent DDL, mirroring the pattern used by data-request-email-exhaustion.
async function ensureLevyReceiptSchema() {
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
    CREATE TABLE IF NOT EXISTS member_levies (
      id serial PRIMARY KEY,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      amount numeric(12,2) NOT NULL,
      currency text NOT NULL DEFAULT 'INR',
      scope text NOT NULL DEFAULT 'all',
      scope_filter jsonb,
      due_date timestamptz,
      status text NOT NULL DEFAULT 'draft',
      applied_at timestamptz,
      applied_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_levy_charges (
      id serial PRIMARY KEY,
      levy_id integer NOT NULL REFERENCES member_levies(id) ON DELETE CASCADE,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      amount numeric(12,2) NOT NULL,
      paid boolean NOT NULL DEFAULT false,
      paid_at timestamptz,
      status text NOT NULL DEFAULT 'unpaid',
      paid_amount numeric(12,2) NOT NULL DEFAULT 0,
      refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
      waived_reason text,
      invoice_id integer,
      last_receipt_status text,
      last_receipt_reason text,
      last_receipt_kind text,
      last_receipt_amount numeric(12,2),
      last_receipt_note text,
      last_receipt_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_levy_receipt_attempts (
      id serial PRIMARY KEY,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      charge_id integer NOT NULL REFERENCES member_levy_charges(id) ON DELETE CASCADE,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      kind text NOT NULL,
      levy_name text NOT NULL,
      currency text NOT NULL,
      transaction_amount numeric(12,2) NOT NULL,
      new_balance numeric(12,2) NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      push_status text,
      push_attempts integer NOT NULL DEFAULT 0,
      last_push_at timestamptz,
      last_push_error text,
      last_push_retry_at timestamptz,
      push_retry_exhausted_at timestamptz,
      sms_status text,
      sms_attempts integer NOT NULL DEFAULT 0,
      last_sms_at timestamptz,
      last_sms_error text,
      last_sms_retry_at timestamptz,
      sms_retry_exhausted_at timestamptz
    )
  `);
  // Defensive ALTERs for the per-revision columns that follow-on migrations
  // append to the attempts table.
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS push_exhaustion_notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS sms_exhaustion_notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS whatsapp_status text`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS whatsapp_attempts integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS last_whatsapp_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS last_whatsapp_error text`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_levy_receipt_attempts ADD COLUMN IF NOT EXISTS last_whatsapp_message_id text`);
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  // Older test DBs may have the org_role enum without the finance/membership
  // values. Add them idempotently so role fixtures work.
  await db.execute(sql`ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'treasurer'`);
  await db.execute(sql`ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'membership_secretary'`);
  await db.execute(sql`ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'committee_member'`);
  await db.execute(sql`ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'competition_secretary'`);
}

// Default push mock impl: per-member receipt retry pushes (data.type ===
// "levy_receipt") fail; everything else (admin exhaustion alert) succeeds.
function defaultPushImpl() {
  sendTransactionalPushMock.mockImplementation(async (
    userIds: number[],
    _title: string,
    _body: string,
    data?: Record<string, unknown>,
  ) => {
    if (data?.type === "levy_receipt") {
      // Receipt retry to the member — force-fail so the cron flips status
      // to 'failed' and stamps `pushRetryExhaustedAt`.
      return { attempted: userIds.length, sent: 0, failed: userIds.length, invalid: 0 };
    }
    return { attempted: userIds.length, sent: userIds.length, failed: 0, invalid: 0 };
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testMemberId: number;
let testMemberUserId: number;
let directAdminId: number;
let membershipAdminId: number;
let treasurerUserId: number;
let membershipSecretaryUserId: number;
let nonPrivilegedUserId: number;

const createdAttemptIds: number[] = [];
const createdChargeIds: number[] = [];
const createdLevyIds: number[] = [];

beforeAll(async () => {
  await ensureLevyReceiptSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyReceiptExhaust_${ts}`,
    slug: `test-levy-receipt-exhaust-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // Member who owns the levy charge being notified about.
  const [memberUser] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-member-${ts}`,
    username: `levy_exhaust_member_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  testMemberUserId = memberUser.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Exhausted",
    lastName: "Member",
    email: "exhaust-receipt@example.test",
    phone: "+911234599001",
    userId: testMemberUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  // Admins who should be notified.
  const [directAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-direct-admin-${ts}`,
    username: `levy_exhaust_direct_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  directAdminId = directAdmin.id;

  const [membershipAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-membership-admin-${ts}`,
    username: `levy_exhaust_membership_admin_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipAdminId = membershipAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipAdminId,
    role: "org_admin",
  });

  // Finance & member-services roles named in the Task #344 spec — both
  // should also be on the receipt-failure alert so finance staff don't
  // miss it.
  const [treasurerUser] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-treasurer-${ts}`,
    username: `levy_exhaust_treasurer_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  treasurerUserId = treasurerUser.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: treasurerUserId,
    role: "treasurer",
  });

  const [memberSecUser] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-memsec-${ts}`,
    username: `levy_exhaust_memsec_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  membershipSecretaryUserId = memberSecUser.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: membershipSecretaryUserId,
    role: "membership_secretary",
  });

  // A non-privileged member of the same org — must NOT receive the alert.
  // Locks the recipient boundary so a future widening of the role list
  // doesn't accidentally fan-out to ordinary players.
  const [nonPrivilegedUser] = await db.insert(appUsersTable).values({
    replitUserId: `levy-exhaust-player-${ts}`,
    username: `levy_exhaust_player_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  nonPrivilegedUserId = nonPrivilegedUser.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: nonPrivilegedUserId,
    role: "player",
  });
});

afterAll(async () => {
  for (const id of createdAttemptIds) {
    await db.delete(memberLevyReceiptAttemptsTable).where(eq(memberLevyReceiptAttemptsTable.id, id));
  }
  for (const id of createdChargeIds) {
    await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, id));
  }
  for (const id of createdLevyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const uid of [directAdminId, membershipAdminId, treasurerUserId, membershipSecretaryUserId, nonPrivilegedUserId, testMemberUserId]) {
    if (uid != null) await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  sendTransactionalPushMock.mockReset();
  sendTransactionalSmsMock.mockReset();
  sendTransactionalWhatsappMock.mockReset();
  defaultPushImpl();
  sendTransactionalSmsMock.mockResolvedValue(undefined);
  sendTransactionalWhatsappMock.mockResolvedValue(undefined);
});

async function makeCharge(): Promise<number> {
  // Create a fresh levy per charge so the (levy_id, club_member_id) uniqueness
  // constraint doesn't reject repeat inserts across tests reusing testMemberId.
  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "Annual Subscription",
    amount: "1000.00",
    currency: "INR",
    status: "applied",
  }).returning({ id: memberLeviesTable.id });
  createdLevyIds.push(levy.id);
  const [charge] = await db.insert(memberLevyChargesTable).values({
    levyId: levy.id,
    clubMemberId: testMemberId,
    amount: "1000.00",
  }).returning({ id: memberLevyChargesTable.id });
  createdChargeIds.push(charge.id);
  return charge.id;
}

/**
 * Insert an attempts row that's exactly one retry away from the per-channel
 * cap (initial attempt + 4 retries → next retry is the 5th and final).
 * Caller specifies which channel is the failing one; the other channel is
 * marked 'sent' so the cron's per-channel `if` blocks are isolated and only
 * the channel under test is retried.
 */
async function insertAttemptOneShortOfCap(opts: { channel: "push" | "sms" }): Promise<MemberLevyReceiptAttempt> {
  const chargeId = await makeCharge();
  const now = new Date();
  const failingPush = opts.channel === "push";
  const [row] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: testOrgId,
    chargeId,
    clubMemberId: testMemberId,
    kind: "payment",
    levyName: "Annual Subscription",
    currency: "INR",
    transactionAmount: "1000.00",
    newBalance: "0.00",
    pushStatus: failingPush ? "failed" : "sent",
    pushAttempts: failingPush ? 4 : 1,
    lastPushAt: now,
    lastPushError: failingPush ? "fcm 500" : null,
    smsStatus: failingPush ? "sent" : "failed",
    smsAttempts: failingPush ? 1 : 4,
    lastSmsAt: now,
    lastSmsError: failingPush ? null : "twilio 500",
    whatsappStatus: "sent",
    whatsappAttempts: 1,
  }).returning();
  createdAttemptIds.push(row.id);
  return row as MemberLevyReceiptAttempt;
}

// ── 1. Push channel exhaustion ────────────────────────────────────────────

describe("retryFailedLevyReceiptPushSms — push retry exhaustion alert", () => {
  it("stamps push exhaustion + push-tagged in-app message + admin push, and dedups on a second pass", async () => {
    const attempt = await insertAttemptOneShortOfCap({ channel: "push" });

    await retryFailedLevyReceiptPushSms();

    // The retry should have flipped the row to exhausted and stamped the
    // dedup marker.
    const [reloaded] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
    expect(reloaded.pushAttempts).toBe(5);
    expect(reloaded.pushRetryExhaustedAt).not.toBeNull();
    expect(reloaded.pushExhaustionNotifiedAt).not.toBeNull();
    // SMS side untouched.
    expect(reloaded.smsExhaustionNotifiedAt).toBeNull();

    // Exactly one in-app message tagged for this attempt + push channel.
    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].organizationId).toBe(testOrgId);
    expect(msgs[0].clubMemberId).toBe(testMemberId);
    expect(msgs[0].channel).toBe("in_app");
    expect(msgs[0].status).toBe("sent");
    expect(msgs[0].senderUserId).toBeNull();

    // Push fan-out happened: at least one call carrying the admin
    // exhaustion type to the admin user set (direct + membership admin).
    const adminCalls = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_push_exhausted",
    );
    expect(adminCalls.length).toBe(1);
    const [recipients] = adminCalls[0] as [number[], string, string, Record<string, unknown>];
    const recipientSet = new Set(recipients);
    expect(recipientSet.has(directAdminId)).toBe(true);
    expect(recipientSet.has(membershipAdminId)).toBe(true);
    // Member is NOT on the admin alert.
    expect(recipientSet.has(testMemberUserId)).toBe(false);

    // Second cron pass: row is past the cap (and dedup is stamped) — no
    // new in-app message and no new admin push.
    sendTransactionalPushMock.mockClear();
    await retryFailedLevyReceiptPushSms();

    const msgsAfter = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgsAfter).toHaveLength(1);
    const adminCallsAfter = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_push_exhausted",
    );
    expect(adminCallsAfter).toHaveLength(0);
  });

  it("a direct second call to the notify helper is a no-op (dedup stamp)", async () => {
    const attempt = await insertAttemptOneShortOfCap({ channel: "push" });
    await retryFailedLevyReceiptPushSms();

    const [reloaded] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

    sendTransactionalPushMock.mockClear();
    const second = await notifyAdminsOfLevyReceiptRetryExhaustion({
      attempt: reloaded as MemberLevyReceiptAttempt,
      channel: "push",
    });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgs).toHaveLength(1);
  });
});

// ── 2. SMS channel exhaustion ─────────────────────────────────────────────

describe("retryFailedLevyReceiptPushSms — SMS retry exhaustion alert", () => {
  it("stamps SMS exhaustion + sms-tagged in-app message + admin push, and dedups on a second pass", async () => {
    // Force SMS retry to fail with a non-provider-config error so the cron
    // flips the row to 'failed' (rather than terminal 'skipped').
    sendTransactionalSmsMock.mockRejectedValue(new Error("twilio 500 service unavailable"));

    const attempt = await insertAttemptOneShortOfCap({ channel: "sms" });

    await retryFailedLevyReceiptPushSms();

    const [reloaded] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
    expect(reloaded.smsAttempts).toBe(5);
    expect(reloaded.smsRetryExhaustedAt).not.toBeNull();
    expect(reloaded.smsExhaustionNotifiedAt).not.toBeNull();
    // Push side untouched.
    expect(reloaded.pushExhaustionNotifiedAt).toBeNull();

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_sms_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].organizationId).toBe(testOrgId);
    expect(msgs[0].clubMemberId).toBe(testMemberId);
    expect(msgs[0].channel).toBe("in_app");

    const adminCalls = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_sms_exhausted",
    );
    expect(adminCalls.length).toBe(1);
    const [recipients] = adminCalls[0] as [number[], string, string, Record<string, unknown>];
    const recipientSet = new Set(recipients);
    expect(recipientSet.has(directAdminId)).toBe(true);
    expect(recipientSet.has(membershipAdminId)).toBe(true);

    // Second cron pass: nothing new.
    sendTransactionalPushMock.mockClear();
    await retryFailedLevyReceiptPushSms();

    const msgsAfter = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_sms_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgsAfter).toHaveLength(1);
    const adminCallsAfter = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_sms_exhausted",
    );
    expect(adminCallsAfter).toHaveLength(0);
  });

  it("a direct second call to the notify helper is a no-op (dedup stamp)", async () => {
    sendTransactionalSmsMock.mockRejectedValue(new Error("twilio 500 service unavailable"));

    const attempt = await insertAttemptOneShortOfCap({ channel: "sms" });
    await retryFailedLevyReceiptPushSms();

    const [reloaded] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

    sendTransactionalPushMock.mockClear();
    const second = await notifyAdminsOfLevyReceiptRetryExhaustion({
      attempt: reloaded as MemberLevyReceiptAttempt,
      channel: "sms",
    });
    expect(second.notified).toBe(false);
    expect(second.recipients).toBe(0);

    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_sms_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgs).toHaveLength(1);
  });
});

// ── 3. Deep link payload ───────────────────────────────────────────────────

describe("notifyAdminsOfLevyReceiptRetryExhaustion — admin deep link", () => {
  it("dispatches a push to admins carrying the /member-360/:memberId?tab=billing&charge=:chargeId deep link", async () => {
    const attempt = await insertAttemptOneShortOfCap({ channel: "push" });

    const res = await notifyAdminsOfLevyReceiptRetryExhaustion({
      attempt,
      channel: "push",
    });
    expect(res.notified).toBe(true);
    expect(res.recipients).toBeGreaterThan(0);

    const adminCalls = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_push_exhausted",
    );
    expect(adminCalls).toHaveLength(1);
    const [recipients, , , data] = adminCalls[0] as [number[], string, string, Record<string, unknown>];

    const expectedDeepLink = `/member-360/${attempt.clubMemberId}?tab=billing&charge=${attempt.chargeId}`;
    expect(data.route).toBe(expectedDeepLink);
    expect(data.attemptId).toBe(attempt.id);
    expect(data.chargeId).toBe(attempt.chargeId);
    expect(data.clubMemberId).toBe(attempt.clubMemberId);

    // Recipients are the admin user-set, not the member. The Task #344
    // spec calls out three role buckets that must all receive the alert:
    // org_admin (both as a direct app_users.role and as an org_membership
    // role), treasurer, and membership_secretary.
    const recipientSet = new Set(recipients);
    expect(recipientSet.has(directAdminId)).toBe(true);          // app_users.role = org_admin
    expect(recipientSet.has(membershipAdminId)).toBe(true);      // org_memberships.role = org_admin
    expect(recipientSet.has(treasurerUserId)).toBe(true);        // org_memberships.role = treasurer
    expect(recipientSet.has(membershipSecretaryUserId)).toBe(true); // org_memberships.role = membership_secretary
    // The affected member and any non-privileged member of the org must
    // NOT be on the alert.
    expect(recipientSet.has(testMemberUserId)).toBe(false);
    expect(recipientSet.has(nonPrivilegedUserId)).toBe(false);

    // The in-app message body still references the Member 360 follow-up
    // location, so admins reading the timeline know where to go even if
    // they're not on the device that received the push.
    const msgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain("Member 360");
  });
});

// ── 4. Transactional safety on partial failure ────────────────────────────

describe("notifyAdminsOfLevyReceiptRetryExhaustion — transactional safety", () => {
  it("when the in-app message insert throws, the dedup column is NOT stamped so the alert can be re-attempted", async () => {
    // Real attempt row backing the dedup column we're protecting.
    const attempt = await insertAttemptOneShortOfCap({ channel: "push" });

    // Force the in-app insert to fail by pointing the helper at a
    // club_member_id that does not exist in club_members. The lookup at the
    // top of the helper just returns no row (memberName falls back to a
    // generic label), but the INSERT into member_messages then violates the
    // club_member_id FK and rolls back the whole transaction — including
    // the dedup stamp UPDATE.
    const bogusMemberId = 2_000_000_000;
    const fakeAttempt: MemberLevyReceiptAttempt = {
      ...attempt,
      clubMemberId: bogusMemberId,
    };

    sendTransactionalPushMock.mockClear();
    await expect(
      notifyAdminsOfLevyReceiptRetryExhaustion({ attempt: fakeAttempt, channel: "push" }),
    ).rejects.toThrow();

    // Dedup MUST still be NULL — otherwise the next cron pass would silently
    // skip alerting and finance staff would never learn about the failure.
    const [afterFailure] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
    expect(afterFailure.pushExhaustionNotifiedAt).toBeNull();

    // No in-app message was persisted (transaction rolled back).
    const failedMsgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(failedMsgs).toHaveLength(0);

    // No admin alert push was dispatched (it only fires after the txn wins).
    const adminCalls = sendTransactionalPushMock.mock.calls.filter(
      ([, , , data]) => (data as { type?: string } | undefined)?.type === "levy_receipt_push_exhausted",
    );
    expect(adminCalls).toHaveLength(0);

    // A subsequent retry with the correct member is able to win the dedup
    // race and notify, proving the alert was not permanently suppressed.
    const recovered = await notifyAdminsOfLevyReceiptRetryExhaustion({
      attempt,
      channel: "push",
    });
    expect(recovered.notified).toBe(true);

    const [afterRecovery] = await db.select()
      .from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
    expect(afterRecovery.pushExhaustionNotifiedAt).not.toBeNull();

    const finalMsgs = await db.select().from(memberMessagesTable).where(and(
      eq(memberMessagesTable.relatedEntity, "levy_receipt_push_exhausted"),
      eq(memberMessagesTable.relatedEntityId, attempt.id),
    ));
    expect(finalMsgs).toHaveLength(1);
  });
});
