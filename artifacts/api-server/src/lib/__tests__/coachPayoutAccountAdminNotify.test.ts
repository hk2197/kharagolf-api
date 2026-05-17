/**
 * Integration tests for `notifyOrgAdminsCoachPayoutAccountChanged` (Task #1060).
 *
 * Covers the org-admin oversight email that fires alongside the coach-side
 * payout-account security alert:
 *   1. Resolves recipients from both `app_users.role='org_admin'` and the
 *      `org_memberships.role='org_admin'` paths and de-duplicates them.
 *   2. Excludes the admin who actually made the change from the email/digest
 *      list (but still writes an audit row for them).
 *   3. Honours `userNotificationPrefs.digestMode = true` by enqueuing into
 *      `notification_digest_queue` instead of sending a per-event email.
 *   4. Honours `userNotificationPrefs.preferEmail = false` by skipping the
 *      send entirely (audit-only).
 *   5. Skips cleanly when an org has no admins.
 *
 * The mailer transport is mocked via `vi.mock` so the suite never touches
 * SMTP. The Postgres database is real (matches the convention used by the
 * other api-server integration tests under this folder).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const {
  sendCoachPayoutAccountChangedEmailMock,
  sendCoachPayoutAccountChangedAdminEmailMock,
  classifyMailerErrorMock,
} = vi.hoisted(() => ({
  sendCoachPayoutAccountChangedEmailMock: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => {},
  ),
  sendCoachPayoutAccountChangedAdminEmailMock: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => {},
  ),
  // Task #1502 — classifier is consulted in the per-recipient email-error
  // catch to mark the admin audit row `skipped`/`provider_not_configured`
  // when the env is misconfigured (rather than a misleading `failed`).
  // Defaults to "transient" so existing tests behave unchanged; individual
  // tests override per-call to exercise the provider-unconfigured branch.
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

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  userNotificationPrefsTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { notifyOrgAdminsCoachPayoutAccountChanged } from "../coachPayoutAccountChangeNotify.js";

// ── Cleanup tracking ─────────────────────────────────────────────────────

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];
const createdHistoryIds: number[] = [];

beforeAll(async () => {
  // No-op; per-test setup creates everything.
});

afterAll(async () => {
  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountHistoryTable).where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  // Wipe digest + audit rows we created (keyed on our notification key).
  await db.delete(notificationDigestQueueTable).where(eq(notificationDigestQueueTable.notificationKey, "coach.payout.account.changed.admin"));
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.admin"));
  // Users must be deleted BEFORE orgs because some test users carry an
  // `organizationId` FK to organizations (the "direct admin" pattern).
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  sendCoachPayoutAccountChangedEmailMock.mockClear();
  sendCoachPayoutAccountChangedAdminEmailMock.mockClear();
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

async function makeUser(label: string, opts: { email?: string | null; role?: "player" | "org_admin"; organizationId?: number | null } = {}): Promise<number> {
  const stamp = uniq(label);
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `payout-admin-notify-${stamp}`,
    username: `pa_${stamp}`,
    email: opts.email === undefined ? `${stamp}@example.com` : opts.email,
    displayName: `User ${label}`,
    role: opts.role ?? "player",
    organizationId: opts.organizationId ?? null,
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

async function makeHistoryRow(opts: {
  proId: number;
  organizationId: number;
  changedByUserId: number | null;
  changedByRole: "coach" | "admin";
  changeKind?: "created" | "updated" | "admin_reverify";
}): Promise<number> {
  const [h] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId: opts.proId,
    organizationId: opts.organizationId,
    changedByUserId: opts.changedByUserId,
    changedByRole: opts.changedByRole,
    changeKind: opts.changeKind ?? "updated",
    method: "upi",
    accountHolderName: "Test Coach",
    upiVpaMasked: "te****@ybl",
    ipAddress: "10.0.0.1",
    userAgent: "vitest",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(h.id);
  return h.id;
}

async function setPrefs(userId: number, opts: { preferEmail?: boolean; digestMode?: boolean; notifyCoachPayoutAccountChanges?: boolean }): Promise<void> {
  await db.insert(userNotificationPrefsTable).values({
    userId,
    preferEmail: opts.preferEmail ?? true,
    digestMode: opts.digestMode ?? false,
    notifyCoachPayoutAccountChanges: opts.notifyCoachPayoutAccountChanges ?? true,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("notifyOrgAdminsCoachPayoutAccountChanged — recipient resolution", () => {
  it("emails every org_admin (direct + membership) and excludes the actor", async () => {
    const orgId = await makeOrg("admin-fanout");
    const directAdmin = await makeUser("direct-admin", { role: "org_admin", organizationId: orgId });
    const memberAdmin = await makeUser("member-admin");
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: memberAdmin, role: "org_admin" });
    const td = await makeUser("td");
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: td, role: "tournament_director" });
    const actorAdmin = await makeUser("actor-admin");
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: actorAdmin, role: "org_admin" });

    const proId = await makePro(orgId);
    const historyId = await makeHistoryRow({
      proId,
      organizationId: orgId,
      changedByUserId: actorAdmin,
      changedByRole: "admin",
    });

    const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

    expect(result.status).toBe("sent");
    expect(result.recipientsAttempted).toBe(2); // directAdmin + memberAdmin (actor excluded)
    expect(result.recipientsEmailed).toBe(2);
    expect(result.recipientsDigested).toBe(0);

    expect(sendCoachPayoutAccountChangedAdminEmailMock).toHaveBeenCalledTimes(2);
    const emailedTos = sendCoachPayoutAccountChangedAdminEmailMock.mock.calls.map(c => (c[0] as { to: string }).to);
    const expectedEmails = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(inArray(appUsersTable.id, [directAdmin, memberAdmin]));
    expect(emailedTos.sort()).toEqual(expectedEmails.map(r => r.email).filter(Boolean).sort());

    // TD must not be alerted (financial-controls scope is org_admin only).
    const tdEmail = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, td));
    expect(emailedTos).not.toContain(tdEmail[0].email);

    // Audit row count: one per resolved admin (excluding the actor).
    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.admin"));
    const auditUserIds = new Set(audits.map(a => a.userId));
    expect(auditUserIds.has(directAdmin)).toBe(true);
    expect(auditUserIds.has(memberAdmin)).toBe(true);
    expect(auditUserIds.has(actorAdmin)).toBe(false);
  });

  it("skips with 'no_org_admins' when the org has no admins", async () => {
    const orgId = await makeOrg("no-admins");
    const player = await makeUser("only-player");
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: player, role: "player" });

    const proId = await makePro(orgId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: player, changedByRole: "coach",
    });

    const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_org_admins");
    expect(sendCoachPayoutAccountChangedAdminEmailMock).not.toHaveBeenCalled();
  });
});

describe("notifyOrgAdminsCoachPayoutAccountChanged — per-recipient channel preferences", () => {
  it("enqueues a digest entry instead of an email when digestMode=true", async () => {
    const orgId = await makeOrg("digest");
    const digestAdmin = await makeUser("digest-admin", { role: "org_admin", organizationId: orgId });
    const eagerAdmin = await makeUser("eager-admin", { role: "org_admin", organizationId: orgId });
    await setPrefs(digestAdmin, { digestMode: true });

    const proId = await makePro(orgId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: null, changedByRole: "coach",
    });

    const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

    expect(result.status).toBe("sent");
    expect(result.recipientsEmailed).toBe(1);
    expect(result.recipientsDigested).toBe(1);

    // Eager admin gets the email; digest admin does NOT.
    expect(sendCoachPayoutAccountChangedAdminEmailMock).toHaveBeenCalledTimes(1);
    const eagerEmail = (await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, eagerAdmin)))[0].email;
    expect(sendCoachPayoutAccountChangedAdminEmailMock.mock.calls[0]![0].to).toBe(eagerEmail);

    // Digest queue gets one row for the digest-mode admin.
    const queueRows = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, digestAdmin));
    expect(queueRows.length).toBe(1);
    expect(queueRows[0].notificationKey).toBe("coach.payout.account.changed.admin");
    expect(queueRows[0].title).toContain("Payout account");
  });

  it("skips per-event opt-out (notifyCoachPayoutAccountChanges=false) audit-only even with digestMode=true", async () => {
    const orgId = await makeOrg("event-opt-out");
    const optedOutAdmin = await makeUser("event-opted-out-admin", { role: "org_admin", organizationId: orgId });
    // Even with digestMode on, the per-event flag should win and the
    // recipient should NOT be enqueued into the digest.
    await setPrefs(optedOutAdmin, { digestMode: true, notifyCoachPayoutAccountChanges: false });

    const proId = await makePro(orgId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: null, changedByRole: "coach",
    });

    const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("all_recipients_audit_only");
    expect(result.recipientsAuditOnly).toBe(1);
    expect(result.recipientsEmailed).toBe(0);
    expect(result.recipientsDigested).toBe(0);
    expect(sendCoachPayoutAccountChangedAdminEmailMock).not.toHaveBeenCalled();

    // No digest enqueue, even though digestMode=true globally.
    const queueRows = await db.select().from(notificationDigestQueueTable)
      .where(eq(notificationDigestQueueTable.userId, optedOutAdmin));
    expect(queueRows.length).toBe(0);

    // Audit row still written so dispatch trail is complete.
    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, optedOutAdmin));
    expect(audits.length).toBe(1);
    expect(audits[0].channel).toBe("skipped");
    expect(audits[0].reason).toBe("event_opted_out");
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 658).
  // A misconfigured mailer is an env-wide condition, not a per-recipient
  // bounce. The per-admin email-error catch must classify it via
  // `classifyMailerError` and write the audit row as
  // `status="skipped"`/`reason="provider_not_configured"` (instead of
  // `failed`), and skip the warn line so admins aren't alerted N times
  // for the same env issue. The recipient is NOT counted in
  // `recipientsEmailed` (the send didn't actually deliver).
  it("provider_unconfigured: writes admin audit row as skipped/provider_not_configured and suppresses warn", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    sendCoachPayoutAccountChangedAdminEmailMock.mockRejectedValueOnce(
      new Error("RESEND_API_KEY not set"),
    );
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      const orgId = await makeOrg("admin-provider-unconfigured");
      const adminUserId = await makeUser("admin-prov-unconf", { role: "org_admin", organizationId: orgId });
      const proId = await makePro(orgId);
      const historyId = await makeHistoryRow({
        proId, organizationId: orgId, changedByUserId: null, changedByRole: "coach",
      });

      const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

      // Email send was attempted exactly once (then mapped to skipped).
      expect(sendCoachPayoutAccountChangedAdminEmailMock).toHaveBeenCalledTimes(1);
      // Recipient counted as attempted, but NOT as emailed (didn't deliver).
      expect(result.recipientsAttempted).toBe(1);
      expect(result.recipientsEmailed).toBe(0);
      expect(result.recipientsDigested).toBe(0);

      // The provider_unconfigured branch must NOT log a warn for the
      // admin email send failure (the standard `failed` path does).
      const provWarn = warnSpy.mock.calls.find(args => {
        const msg = (typeof args[1] === "string" ? args[1] : "");
        return msg.includes("[coach-payout-account-change-notify]") && msg.includes("admin email send failed");
      });
      expect(provWarn).toBeUndefined();

      // Audit row carries the skipped/provider_not_configured outcome
      // so the dispatch trail truthfully reflects an env issue rather
      // than a per-recipient delivery failure.
      const audits = await db.select().from(notificationAuditLogTable)
        .where(eq(notificationAuditLogTable.userId, adminUserId));
      const adminAudit = audits.find(a => a.notificationKey === "coach.payout.account.changed.admin");
      expect(adminAudit?.channel).toBe("email");
      expect(adminAudit?.status).toBe("skipped");
      expect(adminAudit?.reason).toBe("provider_not_configured");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Task #2135 — admin email URL must deep-link the payout-history
  // dialog to the chip matching the change kind (admin_reverify lands
  // on the Admin re-verifications chip; created/updated land on their
  // own chips) so admins skip the manual filter click. Unknown change
  // kinds fall back to the bare `#payout-history` so the dialog still
  // opens (just unfiltered) instead of silently doing nothing.
  it("admin email URL pre-filters #payout-history by change kind", async () => {
    const orgId = await makeOrg("url-hash");
    // Only the side effect (an org_admin row in this org) matters here;
    // we don't reference the user id directly in assertions.
    await makeUser("url-hash-admin", { role: "org_admin", organizationId: orgId });
    const proId = await makePro(orgId);
    const cases: Array<{ kind: "created" | "updated" | "admin_reverify"; expectedHashSuffix: string }> = [
      { kind: "created", expectedHashSuffix: "#payout-history=created" },
      { kind: "updated", expectedHashSuffix: "#payout-history=updated" },
      { kind: "admin_reverify", expectedHashSuffix: "#payout-history=admin_reverify" },
    ];
    for (const c of cases) {
      sendCoachPayoutAccountChangedAdminEmailMock.mockClear();
      const historyId = await makeHistoryRow({
        proId,
        organizationId: orgId,
        changedByUserId: null,
        changedByRole: c.kind === "admin_reverify" ? "admin" : "coach",
        changeKind: c.kind,
      });
      const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);
      expect(result.status).toBe("sent");
      expect(sendCoachPayoutAccountChangedAdminEmailMock).toHaveBeenCalledTimes(1);
      const opts = sendCoachPayoutAccountChangedAdminEmailMock.mock.calls[0]![0] as
        { to: string; adminHistoryUrl?: string };
      expect(opts.to).toBeTruthy();
      // The URL must point at the per-coach admin view AND carry the
      // matching `=changeKind` filter on the hash so the dialog opens
      // pre-filtered to the right chip.
      expect(opts.adminHistoryUrl).toBeDefined();
      expect(opts.adminHistoryUrl!).toContain(`/coach-admin?coach=${proId}${c.expectedHashSuffix}`);
      // Sanity: no double `#payout-history` segment leaked in (regression
      // guard against accidentally appending the kind to a bare hash).
      expect(opts.adminHistoryUrl!.match(/#payout-history/g)?.length ?? 0).toBe(1);
    }
  });

  it("skips email entirely when preferEmail=false (audit-only)", async () => {
    const orgId = await makeOrg("noemail");
    const optedOutAdmin = await makeUser("opted-out-admin", { role: "org_admin", organizationId: orgId });
    await setPrefs(optedOutAdmin, { preferEmail: false });

    const proId = await makePro(orgId);
    const historyId = await makeHistoryRow({
      proId, organizationId: orgId, changedByUserId: null, changedByRole: "coach",
    });

    const result = await notifyOrgAdminsCoachPayoutAccountChanged(historyId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("all_recipients_audit_only");
    expect(result.recipientsAuditOnly).toBe(1);
    expect(result.recipientsEmailed).toBe(0);
    expect(sendCoachPayoutAccountChangedAdminEmailMock).not.toHaveBeenCalled();

    // Audit row still written so dispatch trail is complete.
    const audits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, optedOutAdmin));
    expect(audits.length).toBe(1);
    expect(audits[0].channel).toBe("skipped");
    expect(audits[0].reason).toBe("email_opted_out");
  });
});
