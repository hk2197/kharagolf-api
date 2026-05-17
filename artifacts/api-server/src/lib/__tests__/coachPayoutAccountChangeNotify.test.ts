/**
 * Integration tests for `notifyCoachPayoutAccountChanged` (Task #1059).
 *
 * Covers the coach-side fan-out that fires after a successful create/update
 * of a coach's payout account. The helper has three legs:
 *
 *   - email        → `sendCoachPayoutAccountChangedEmail`
 *   - in-app inbox → `member_messages` row (only when the coach has an
 *                    active `club_members` row in the org that owns the
 *                    payout account, since the inbox is keyed off
 *                    clubMemberId)
 *   - push         → `sendPushToUsers` with payload type
 *                    `coach_payout_account_changed`, gated by
 *                    `userNotificationPrefs.preferPush`
 *
 * Every leg is best-effort: a failure on one leg must not poison the others,
 * and the aggregate `result.status` must reflect "any leg sent → sent;
 * else any leg failed → failed; else skipped".
 *
 * The mailer + push transports are mocked via `vi.mock` so the suite never
 * touches SMTP / Expo. The Postgres database is real (matches the convention
 * used by every other api-server integration test under this folder).
 *
 * NOTE: the helper also fire-and-forgets `notifyOrgAdminsCoachPayoutAccountChanged`
 * which is exercised independently by `coachPayoutAccountAdminNotify.test.ts`.
 * Our test orgs intentionally do NOT seed any `org_admin` members so the
 * background admin call exits early with `no_org_admins` and produces no
 * digest / audit / mailer side effects that could pollute these assertions.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

const {
  sendCoachPayoutAccountChangedEmailMock,
  sendCoachPayoutAccountChangedAdminEmailMock,
  sendPushToUsersMock,
  classifyMailerErrorMock,
} = vi.hoisted(() => ({
  sendCoachPayoutAccountChangedEmailMock: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => {},
  ),
  sendCoachPayoutAccountChangedAdminEmailMock: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => {},
  ),
  sendPushToUsersMock: vi.fn(async (
    userIds: number[],
    _title: string,
    _body: string,
    _data?: Record<string, unknown>,
  ) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  // Task #1502 — classifier is consulted in the email-error catch to skip
  // billing the inbox when the env is misconfigured. Defaults to "transient"
  // so the existing failure-path assertions (mocked "smtp boom" errors)
  // continue flowing through the standard `failed` path; individual tests
  // override per-call for the provider-not-configured branch.
  classifyMailerErrorMock: vi.fn((_err: unknown) => "transient" as
    | "transient"
    | "provider_unconfigured"
    | "hard_bounce"),
}));

vi.mock("../mailer.js", () => ({
  sendCoachPayoutAccountChangedEmail: sendCoachPayoutAccountChangedEmailMock,
  sendCoachPayoutAccountChangedAdminEmail: sendCoachPayoutAccountChangedAdminEmailMock,
  classifyMailerError: classifyMailerErrorMock,
}));

vi.mock("../push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
  // Mirror the real classifier so opted_out / no_address / failed mappings
  // stay accurate without dragging in the Expo SDK.
  classifyPushDelivery: (r: { sent: number; failed: number }) => {
    if (r.sent > 0) return "sent";
    if (r.failed > 0) return "failed";
    return "no_address";
  },
}));

import {
  db,
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  clubMembersTable,
  memberMessagesTable,
  userNotificationPrefsTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { notifyCoachPayoutAccountChanged } from "../coachPayoutAccountChangeNotify.js";

// ── Cleanup tracking ─────────────────────────────────────────────────────

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];
const createdHistoryIds: number[] = [];
const createdClubMemberIds: number[] = [];

afterAll(async () => {
  // Wait one tick so any in-flight admin-notify background tasks
  // (`void notifyOrgAdminsCoachPayoutAccountChanged(...)`) finish their
  // (no-op, since we seed zero org_admins) DB queries before we tear down.
  await new Promise((r) => setTimeout(r, 100));

  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountHistoryTable).where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  if (createdClubMemberIds.length > 0) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.clubMemberId, createdClubMemberIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdClubMemberIds));
  }
  // Belt + braces — wipe any digest/audit rows the (no-op) admin-notify
  // background pass might have written under our notification key.
  await db.delete(notificationDigestQueueTable).where(eq(notificationDigestQueueTable.notificationKey, "coach.payout.account.changed.admin"));
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.admin"));
  // Task #1406 — coach-side audit rows we now write per leg.
  if (createdUserIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      inArray(notificationAuditLogTable.userId, createdUserIds),
    ));
  }
  if (createdUserIds.length > 0) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  sendCoachPayoutAccountChangedEmailMock.mockReset();
  sendCoachPayoutAccountChangedEmailMock.mockImplementation(async () => {});
  sendCoachPayoutAccountChangedAdminEmailMock.mockReset();
  sendCoachPayoutAccountChangedAdminEmailMock.mockImplementation(async () => {});
  sendPushToUsersMock.mockReset();
  sendPushToUsersMock.mockImplementation(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  }));
});

// ── Helpers ──────────────────────────────────────────────────────────────

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOrg(label: string): Promise<number> {
  const stamp = uniq(label);
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`,
    slug: stamp,
  }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(label: string, opts: { email?: string | null } = {}): Promise<number> {
  const stamp = uniq(label);
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `payout-coach-notify-${stamp}`,
    username: `pc_${stamp}`,
    email: opts.email === undefined ? `${stamp}@example.com` : opts.email,
    displayName: `Coach ${label}`,
    role: "player",
  }).returning();
  createdUserIds.push(user.id);
  return user.id;
}

async function makePro(orgId: number, opts: { userId?: number | null } = {}): Promise<number> {
  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    userId: opts.userId ?? null,
    displayName: `Coach ${uniq("c")}`,
  }).returning();
  return pro.id;
}

async function makeClubMember(orgId: number, userId: number): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Test",
    lastName: "Coach",
    email: `cm-${uniq("e")}@example.com`,
  }).returning({ id: clubMembersTable.id });
  createdClubMemberIds.push(m.id);
  return m.id;
}

async function makeHistoryRow(opts: {
  proId: number;
  organizationId: number;
  changedByUserId: number | null;
  changedByRole?: "coach" | "admin";
  changeKind?: "created" | "updated";
  method?: "upi" | "bank_account";
}): Promise<number> {
  const method = opts.method ?? "upi";
  const [h] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId: opts.proId,
    organizationId: opts.organizationId,
    changedByUserId: opts.changedByUserId,
    changedByRole: opts.changedByRole ?? "coach",
    changeKind: opts.changeKind ?? "updated",
    method,
    accountHolderName: "Test Coach",
    upiVpaMasked: method === "upi" ? "te****@ybl" : null,
    bankAccountLast4: method === "bank_account" ? "4321" : null,
    bankIfsc: method === "bank_account" ? "HDFC0001234" : null,
    ipAddress: "10.0.0.1",
    userAgent: "vitest",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(h.id);
  return h.id;
}

async function setPushPref(userId: number, preferPush: boolean): Promise<void> {
  await db.insert(userNotificationPrefsTable).values({ userId, preferPush });
}

interface ScenarioOpts {
  changeKind?: "created" | "updated";
  method?: "upi" | "bank_account";
  changedByRole?: "coach" | "admin";
  withClubMember?: boolean;
  withPushPref?: boolean | undefined; // undefined → no row (defaults to true)
}

interface Scenario {
  orgId: number;
  coachUserId: number;
  proId: number;
  historyId: number;
  clubMemberId: number | null;
}

async function buildScenario(label: string, opts: ScenarioOpts = {}): Promise<Scenario> {
  const orgId = await makeOrg(label);
  const coachUserId = await makeUser(`${label}-coach`);
  const proId = await makePro(orgId, { userId: coachUserId });
  const clubMemberId = opts.withClubMember === false ? null : await makeClubMember(orgId, coachUserId);
  if (opts.withPushPref !== undefined) {
    await setPushPref(coachUserId, opts.withPushPref);
  }
  const historyId = await makeHistoryRow({
    proId,
    organizationId: orgId,
    changedByUserId: coachUserId,
    changedByRole: opts.changedByRole ?? "coach",
    changeKind: opts.changeKind ?? "updated",
    method: opts.method ?? "upi",
  });
  return { orgId, coachUserId, proId, historyId, clubMemberId };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("notifyCoachPayoutAccountChanged — in-app inbox row", () => {
  it("inserts a member_messages row with the 'Payout UPI updated' subject when a UPI account is updated", async () => {
    const { historyId, clubMemberId, orgId } = await buildScenario("inapp-upi-updated", {
      method: "upi",
      changeKind: "updated",
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.inApp.status).toBe("sent");
    expect(result.inApp.messageId).toBeDefined();

    const [row] = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.id, result.inApp.messageId!));
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(orgId);
    expect(row.clubMemberId).toBe(clubMemberId);
    expect(row.channel).toBe("in_app");
    expect(row.subject).toBe("Payout UPI updated");
    expect(row.body).toContain("Your payout UPI was updated");
    expect(row.body).toContain("by you");
    expect(row.relatedEntity).toBe("coach_payout_account_history");
    expect(row.relatedEntityId).toBe(historyId);
    expect(row.status).toBe("sent");
  });

  it("uses 'Payout bank account added' wording when a bank_account is created", async () => {
    const { historyId } = await buildScenario("inapp-bank-added", {
      method: "bank_account",
      changeKind: "created",
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.inApp.status).toBe("sent");
    const [row] = await db.select().from(memberMessagesTable).where(eq(memberMessagesTable.id, result.inApp.messageId!));
    expect(row.subject).toBe("Payout bank account added");
    expect(row.body).toContain("Your payout bank account was created");
  });

  it("skips the in-app leg when the coach has no club_members row in the org", async () => {
    const { historyId, orgId, coachUserId } = await buildScenario("inapp-no-member", {
      withClubMember: false,
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.inApp.status).toBe("skipped");
    expect(result.inApp.messageId).toBeUndefined();

    // And no row exists for that user in this org's inbox.
    const memberRows = await db.select().from(clubMembersTable)
      .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, coachUserId)));
    expect(memberRows).toHaveLength(0);
  });
});

describe("notifyCoachPayoutAccountChanged — push", () => {
  it("calls sendPushToUsers with the coach's userId and the coach_payout_account_changed payload", async () => {
    const { historyId, coachUserId, orgId, proId } = await buildScenario("push-default", {
      method: "upi",
      changeKind: "updated",
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("sent");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [pushedUserIds, pushTitle, pushBody, pushData] = sendPushToUsersMock.mock.calls[0]!;
    expect(pushedUserIds).toEqual([coachUserId]);
    expect(pushTitle).toBe("Payout UPI updated");
    expect(pushBody).toContain("Your payout UPI was updated");
    expect((pushData as Record<string, unknown>).type).toBe("coach_payout_account_changed");
    expect((pushData as Record<string, unknown>).historyId).toBe(historyId);
    expect((pushData as Record<string, unknown>).proId).toBe(proId);
    expect((pushData as Record<string, unknown>).organizationId).toBe(orgId);
    expect((pushData as Record<string, unknown>).changeKind).toBe("updated");
    expect((pushData as Record<string, unknown>).method).toBe("upi");
  });

  it("marks push as 'opted_out' and skips the transport when preferPush=false", async () => {
    const { historyId } = await buildScenario("push-opt-out", { withPushPref: false });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("opted_out");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  it("still pushes when an explicit preferPush=true row exists (sanity control for the opt-out test)", async () => {
    const { historyId, coachUserId } = await buildScenario("push-opt-in", { withPushPref: true });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("sent");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(sendPushToUsersMock.mock.calls[0]![0]).toEqual([coachUserId]);
  });

  it("classifies a push transport that returned zero deliveries as 'no_address' (not failed)", async () => {
    sendPushToUsersMock.mockImplementationOnce(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: 0,
      failed: 0,
      invalid: 0,
    }));
    const { historyId } = await buildScenario("push-no-address");

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("no_address");
    // Email + in-app still went through, so the aggregate is still "sent".
    expect(result.status).toBe("sent");
  });
});

describe("notifyCoachPayoutAccountChanged — email is independent of in-app & push", () => {
  it("calls sendCoachPayoutAccountChangedEmail with the coach's email address", async () => {
    const { historyId, coachUserId } = await buildScenario("email-default");

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.email.status).toBe("sent");
    expect(sendCoachPayoutAccountChangedEmailMock).toHaveBeenCalledTimes(1);
    const [args] = sendCoachPayoutAccountChangedEmailMock.mock.calls[0]!;
    const expected = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, coachUserId));
    expect((args as { to: string }).to).toBe(expected[0].email);
  });

  it("marks email as 'no_address' (not failed) when the coach has no email on file", async () => {
    const orgId = await makeOrg("email-noaddr");
    const coachUserId = await makeUser("email-noaddr-coach", { email: null });
    const proId = await makePro(orgId, { userId: coachUserId });
    await makeClubMember(orgId, coachUserId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: coachUserId,
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.email.status).toBe("no_address");
    expect(sendCoachPayoutAccountChangedEmailMock).not.toHaveBeenCalled();
    // In-app + push still fired → aggregate still "sent".
    expect(result.inApp.status).toBe("sent");
    expect(result.push.status).toBe("sent");
    expect(result.status).toBe("sent");
  });
});

describe("notifyCoachPayoutAccountChanged — best-effort isolation across legs", () => {
  it("an email failure does NOT block the in-app or push legs", async () => {
    sendCoachPayoutAccountChangedEmailMock.mockRejectedValueOnce(new Error("smtp boom"));
    const { historyId, coachUserId } = await buildScenario("email-fails");

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.email.status).toBe("failed");
    expect(result.email.error).toContain("smtp boom");
    // Both other legs still ran and succeeded.
    expect(result.inApp.status).toBe("sent");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(sendPushToUsersMock.mock.calls[0]![0]).toEqual([coachUserId]);
    expect(result.push.status).toBe("sent");
    // At least one leg sent → aggregate is "sent".
    expect(result.status).toBe("sent");
  });

  it("an in-app insert failure does NOT block the email or push legs", async () => {
    // Force the `db.insert(memberMessagesTable)` call inside the helper
    // to reject, leaving every other db.insert call untouched. We can't
    // simulate this via missing FKs (the helper guards on the
    // club_members lookup first and would skip the insert outright), so
    // we patch `db.insert` to fail only for `memberMessagesTable`.
    const originalInsert = db.insert.bind(db);
    const insertSpy = vi.spyOn(db, "insert").mockImplementation((table: unknown) => {
      if (table === memberMessagesTable) {
        return {
          values: () => ({
            returning: () => Promise.reject(new Error("inbox down")),
          }),
        } as unknown as ReturnType<typeof db.insert>;
      }
      return originalInsert(table as Parameters<typeof db.insert>[0]);
    });

    try {
      const { historyId } = await buildScenario("inapp-fails");

      const result = await notifyCoachPayoutAccountChanged(historyId);

      expect(result.inApp.status).toBe("failed");
      expect(result.inApp.error).toContain("inbox down");
      // Email and push still went through.
      expect(result.email.status).toBe("sent");
      expect(result.push.status).toBe("sent");
      expect(sendCoachPayoutAccountChangedEmailMock).toHaveBeenCalledTimes(1);
      expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
      // At least one leg sent → aggregate is "sent".
      expect(result.status).toBe("sent");
    } finally {
      insertSpy.mockRestore();
    }
  });

  it("a push failure does NOT block the in-app or email legs", async () => {
    sendPushToUsersMock.mockRejectedValueOnce(new Error("expo down"));
    const { historyId } = await buildScenario("push-fails");

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("failed");
    expect(result.push.error).toContain("expo down");
    expect(result.email.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(sendCoachPayoutAccountChangedEmailMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("sent");
  });

  it("classifies a transport delivery failure (sent=0, failed>0) as push.status='failed'", async () => {
    sendPushToUsersMock.mockImplementationOnce(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: 0,
      failed: userIds.length,
      invalid: 0,
    }));
    const { historyId } = await buildScenario("push-deliv-failed");

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.push.status).toBe("failed");
    expect(result.push.error).toBe("push_delivery_failed");
    // Email + in-app still went through → aggregate is "sent".
    expect(result.email.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(result.status).toBe("sent");
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 191).
  // A misconfigured mailer is an env-wide condition, not a per-recipient
  // bounce. The helper must classify it via `classifyMailerError` and
  // map the catch to terminal `skipped`/`provider_not_configured` so:
  //   1. the cron-side retry helper (which keys on
  //      `email.status === "failed"`) never re-selects this dispatch, and
  //   2. the warn line is suppressed (admins shouldn't see N "delivery
  //      failed" alerts for a single env-config issue).
  // Push + in-app fan out independently because the email failure is
  // caught and isolated.
  it("provider_unconfigured: marks email skipped/provider_not_configured, suppresses warn, leaves other legs sent", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    sendCoachPayoutAccountChangedEmailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      const { historyId, coachUserId } = await buildScenario("email-provider-unconfigured");
      const result = await notifyCoachPayoutAccountChanged(historyId);

      expect(result.email.status).toBe("skipped");
      expect(result.email.error).toBe("provider_not_configured");
      // Other legs unaffected by the email skip.
      expect(result.inApp.status).toBe("sent");
      expect(result.push.status).toBe("sent");
      // At least one leg sent → aggregate "sent".
      expect(result.status).toBe("sent");

      // The provider_unconfigured branch must NOT log a warn for the
      // email-delivery-failed message (the standard `failed` path does).
      const provWarn = warnSpy.mock.calls.find(args => {
        const msg = (typeof args[1] === "string" ? args[1] : "");
        return msg.includes("[coach-payout-account-change-notify]") && msg.includes("email delivery failed");
      });
      expect(provWarn).toBeUndefined();

      // Coach-side audit row for email reflects the skipped outcome.
      const audits = await loadCoachAudits(coachUserId);
      const email = audits.find(r => r.channel === "email");
      expect(email?.status).toBe("skipped");
      expect(email?.reason).toBe("provider_not_configured");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("aggregate status is 'failed' when every leg failed (push transport, email, AND no club_members row)", async () => {
    sendCoachPayoutAccountChangedEmailMock.mockRejectedValueOnce(new Error("smtp boom"));
    sendPushToUsersMock.mockRejectedValueOnce(new Error("expo down"));
    // No club_members row → in-app skipped (not sent). With email failed,
    // push failed, and in-app skipped, the aggregate must be "failed".
    const { historyId } = await buildScenario("all-fail", { withClubMember: false });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.email.status).toBe("failed");
    expect(result.push.status).toBe("failed");
    expect(result.inApp.status).toBe("skipped");
    expect(result.status).toBe("failed");
    // The reason surfaces one of the underlying errors so callers can log it.
    expect(result.reason).toBeTruthy();
  });
});

// ── Audit trail (Task #1406) ─────────────────────────────────────────────
//
// `notifyOrgAdminsCoachPayoutAccountChanged` writes one
// `notification_audit_log` row per recipient (so admin dispatches are
// traceable end-to-end). Task #1406 extends the same contract to the
// coach-side fanout: one row per leg (email / in-app / push) keyed by
// `coach.payout.account.changed.coach`, attributed to the coach's own
// userId, with the per-leg status + a reason when applicable.
//
// These tests assert the audit rows exist, carry the right channel and
// status, and surface the underlying failure reason for each scenario.

const COACH_AUDIT_KEY = "coach.payout.account.changed.coach";

async function loadCoachAudits(coachUserId: number): Promise<
  Array<{ channel: string; status: string; reason: string | null; payload: Record<string, unknown> }>
> {
  const rows = await db.select({
    channel: notificationAuditLogTable.channel,
    status: notificationAuditLogTable.status,
    reason: notificationAuditLogTable.reason,
    payload: notificationAuditLogTable.payload,
  }).from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.notificationKey, COACH_AUDIT_KEY),
      eq(notificationAuditLogTable.userId, coachUserId),
    ));
  return rows;
}

describe("notifyCoachPayoutAccountChanged — coach-side audit trail", () => {
  it("writes one audit row per leg (email/in_app/push) when every leg succeeds", async () => {
    const { historyId, coachUserId, proId, orgId } = await buildScenario("audit-all-sent", {
      method: "upi",
      changeKind: "updated",
    });

    const result = await notifyCoachPayoutAccountChanged(historyId);

    expect(result.email.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(result.push.status).toBe("sent");

    const audits = await loadCoachAudits(coachUserId);
    // The lib emits one audit row per delivery leg. After the upstream
    // SMS + WhatsApp legs were added, the canonical "all sent" path
    // produces five rows: email / in_app / push / sms / whatsapp.
    expect(audits).toHaveLength(5);

    const byChannel = new Map(audits.map(r => [r.channel, r]));
    expect(byChannel.get("email")?.status).toBe("sent");
    expect(byChannel.get("email")?.reason).toBeNull();
    expect(byChannel.get("in_app")?.status).toBe("sent");
    expect(byChannel.get("in_app")?.reason).toBeNull();
    expect(byChannel.get("push")?.status).toBe("sent");
    expect(byChannel.get("push")?.reason).toBeNull();
    // SMS / WhatsApp default to opted-out when no billing pref row is
    // seeded for the org+coach (the schema default is OFF). The audit
    // row still exists, with the canonical opt-out reason captured.
    expect(byChannel.get("sms")?.status).toBe("opted_out");
    expect(byChannel.get("sms")?.reason).toBe("sms_opted_out");
    expect(byChannel.get("whatsapp")?.status).toBe("opted_out");
    expect(byChannel.get("whatsapp")?.reason).toBe("whatsapp_opted_out");

    // Payload carries enough context to trace the dispatch back to the
    // history row without joining audit_log → history.
    const emailPayload = (byChannel.get("email")?.payload ?? {}) as Record<string, unknown>;
    expect(emailPayload.historyId).toBe(historyId);
    expect(emailPayload.proId).toBe(proId);
    expect(emailPayload.organizationId).toBe(orgId);
    expect(emailPayload.changeKind).toBe("updated");
    expect(emailPayload.method).toBe("upi");
    expect(emailPayload.changedByRole).toBe("coach");
  });

  it("audit row for email captures the smtp failure reason when the mailer rejects", async () => {
    sendCoachPayoutAccountChangedEmailMock.mockRejectedValueOnce(new Error("smtp boom"));
    const { historyId, coachUserId } = await buildScenario("audit-email-failed");

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const email = audits.find(r => r.channel === "email");
    expect(email?.status).toBe("failed");
    expect(email?.reason).toContain("smtp boom");
    // Other legs still got their audit rows alongside the failed one.
    expect(audits.find(r => r.channel === "in_app")?.status).toBe("sent");
    expect(audits.find(r => r.channel === "push")?.status).toBe("sent");
  });

  it("audit row for email carries 'no_email_on_file' reason when the coach has no email address", async () => {
    const orgId = await makeOrg("audit-email-noaddr");
    const coachUserId = await makeUser("audit-email-noaddr-coach", { email: null });
    const proId = await makePro(orgId, { userId: coachUserId });
    await makeClubMember(orgId, coachUserId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: coachUserId,
    });

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const email = audits.find(r => r.channel === "email");
    expect(email?.status).toBe("no_address");
    expect(email?.reason).toBe("no_email_on_file");
  });

  it("audit row for in_app uses 'no_club_member_in_org' reason when the coach has no club_members row", async () => {
    const { historyId, coachUserId } = await buildScenario("audit-inapp-skipped", {
      withClubMember: false,
    });

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const inApp = audits.find(r => r.channel === "in_app");
    expect(inApp?.status).toBe("skipped");
    expect(inApp?.reason).toBe("no_club_member_in_org");
  });

  it("audit row for in_app captures the underlying error when the inbox insert fails", async () => {
    const originalInsert = db.insert.bind(db);
    const insertSpy = vi.spyOn(db, "insert").mockImplementation((table: unknown) => {
      if (table === memberMessagesTable) {
        return {
          values: () => ({
            returning: () => Promise.reject(new Error("inbox down")),
          }),
        } as unknown as ReturnType<typeof db.insert>;
      }
      return originalInsert(table as Parameters<typeof db.insert>[0]);
    });

    try {
      const { historyId, coachUserId } = await buildScenario("audit-inapp-failed");

      await notifyCoachPayoutAccountChanged(historyId);

      const audits = await loadCoachAudits(coachUserId);
      const inApp = audits.find(r => r.channel === "in_app");
      expect(inApp?.status).toBe("failed");
      expect(inApp?.reason).toContain("inbox down");
    } finally {
      insertSpy.mockRestore();
    }
  });

  it("audit row for push uses 'push_opted_out' reason when preferPush=false", async () => {
    const { historyId, coachUserId } = await buildScenario("audit-push-optout", {
      withPushPref: false,
    });

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const push = audits.find(r => r.channel === "push");
    expect(push?.status).toBe("opted_out");
    expect(push?.reason).toBe("push_opted_out");
  });

  it("audit row for push uses 'no_push_token' reason when the transport returned zero deliveries", async () => {
    sendPushToUsersMock.mockImplementationOnce(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: 0,
      failed: 0,
      invalid: 0,
    }));
    const { historyId, coachUserId } = await buildScenario("audit-push-no-addr");

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const push = audits.find(r => r.channel === "push");
    expect(push?.status).toBe("no_address");
    expect(push?.reason).toBe("no_push_token");
  });

  it("audit row for push records 'push_delivery_failed' when the transport reports a delivery failure", async () => {
    sendPushToUsersMock.mockImplementationOnce(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: 0,
      failed: userIds.length,
      invalid: 0,
    }));
    const { historyId, coachUserId } = await buildScenario("audit-push-delivery-failed");

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const push = audits.find(r => r.channel === "push");
    expect(push?.status).toBe("failed");
    expect(push?.reason).toBe("push_delivery_failed");
  });

  it("audit row for push captures the thrown transport error when sendPushToUsers rejects", async () => {
    sendPushToUsersMock.mockRejectedValueOnce(new Error("expo down"));
    const { historyId, coachUserId } = await buildScenario("audit-push-throws");

    await notifyCoachPayoutAccountChanged(historyId);

    const audits = await loadCoachAudits(coachUserId);
    const push = audits.find(r => r.channel === "push");
    expect(push?.status).toBe("failed");
    expect(push?.reason).toContain("expo down");
  });
});
