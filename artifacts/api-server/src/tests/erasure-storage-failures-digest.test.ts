/**
 * Tests for Task #1078 — daily controller digest of stuck erasure cleanups.
 *
 * Covers:
 *   - When the org's stuck count is zero, no email is sent and no dedup
 *     watermark is burned (so a fresh failure tomorrow still triggers).
 *   - When count > 0, every controller (org_admin / membership_secretary /
 *     treasurer) gets exactly one digest email and the per-org
 *     `erasureStorageDigestLastSentOn` watermark is stamped to today's UTC
 *     date.
 *   - Re-running the cron on the same UTC day must NOT double-send.
 *   - The dispatched email body contains a deep link to /privacy and the
 *     affected member's per-row drill-in link.
 *
 * Task #1241 — also verifies that the cron emits an in-app inbox row + push
 * dispatch (via the central `dispatchNotification` helper) to every
 * controller for the org, including controllers without an email on file,
 * carries the same /privacy deep-link surface as the email, and is
 * deduped on the same per-org per-UTC-day watermark.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendErasureStorageFailuresDigestEmail: vi.fn(async () => undefined),
    sendBouncedLevyDigestEmail: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/notifyDispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/notifyDispatch.js")>();
  return {
    ...actual,
    dispatchNotification: vi.fn(async (key: string, userIds: number[]) => ({
      key,
      digestable: false,
      recipients: userIds.map((uid) => ({ userId: uid, channels: [{ channel: "push" as const, status: "sent" as const }] })),
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

import { sendErasureStorageFailuresDigest } from "../lib/cron.js";
import { sendErasureStorageFailuresDigestEmail } from "../lib/mailer.js";
import { dispatchNotification } from "../lib/notifyDispatch.js";

const emailMock = vi.mocked(sendErasureStorageFailuresDigestEmail);
const dispatchMock = vi.mocked(dispatchNotification);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `ErasureDigestTest_${label}_${tag}`,
    slug: `erasure-digest-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `erasure-digest-${tag}`,
    username: `erasure_digest_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeController(orgId: number, role: "org_admin" | "membership_secretary" | "treasurer", email: string, displayName: string): Promise<number> {
  const userId = await makeUser({ email, displayName });
  await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role });
  return userId;
}

async function makeMember(orgId: number, firstName = "Stuck"): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId, firstName, lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function recordStuckErasure(orgId: number, memberId: number, failed: number, when: Date = new Date()) {
  await db.insert(memberAuditLogTable).values({
    organizationId: orgId, clubMemberId: memberId,
    entity: "club_member", entityId: memberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron)",
    createdAt: when,
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 42,
      mediaTablesPurged: { media: 1 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: failed,
      objectStorageFilesFailedPaths: Array.from({ length: failed }, (_, i) => `/objects/${memberId}-${i}`),
      objectStorageDisabled: false,
    },
  });
}

let prevAppBaseUrl: string | undefined;
beforeAll(async () => {
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://test.kharagolf.com";
  // Mirror the schema-tolerance pattern from sibling erasure tests so this
  // suite passes on freshly-cloned local DBs.
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
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
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS erasure_storage_digest_last_sent_on text`);
});

afterAll(async () => {
  if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevAppBaseUrl;
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  dispatchMock.mockClear();
});

describe("sendErasureStorageFailuresDigest", () => {
  it("sends nothing and burns no watermark when the org has zero stuck erasures", async () => {
    const orgId = await makeOrg("zero");
    const memberId = await makeMember(orgId);
    await makeController(orgId, "org_admin", `zero-${orgId}@example.com`, "Zero Admin");
    // Erasure on file but it was clean (failed = 0) — must be ignored.
    await recordStuckErasure(orgId, memberId, 0);

    await sendErasureStorageFailuresDigest();

    const callsForOrg = emailMock.mock.calls.filter(
      ([arg]) => arg.to === `zero-${orgId}@example.com`,
    );
    expect(callsForOrg).toHaveLength(0);

    const [org] = await db.select({
      stamp: organizationsTable.erasureStorageDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    // No watermark burned, so a fresh failure tomorrow still triggers.
    expect(org.stamp).toBeNull();
  });

  it("emails one digest to every controller (admin + membership_secretary + treasurer) when count > 0", async () => {
    const orgId = await makeOrg("count");
    const memberId = await makeMember(orgId, "StuckOne");
    await recordStuckErasure(orgId, memberId, 3);

    await makeController(orgId, "org_admin", `admin-count-${orgId}@example.com`, "Count Admin");
    await makeController(orgId, "membership_secretary", `ms-count-${orgId}@example.com`, "Count MS");
    await makeController(orgId, "treasurer", `tr-count-${orgId}@example.com`, "Count Treasurer");

    await sendErasureStorageFailuresDigest();

    const recipientsForOrg = emailMock.mock.calls
      .map(([arg]) => arg)
      .filter(arg =>
        arg.to === `admin-count-${orgId}@example.com`
        || arg.to === `ms-count-${orgId}@example.com`
        || arg.to === `tr-count-${orgId}@example.com`,
      );
    expect(recipientsForOrg).toHaveLength(3);
    for (const call of recipientsForOrg) {
      expect(call.count).toBe(1);
      expect(call.totalFailedFiles).toBe(3);
      expect(call.items).toHaveLength(1);
      expect(call.items[0].clubMemberId).toBe(memberId);
      expect(call.items[0].objectStorageFilesFailed).toBe(3);
      expect(call.baseUrl).toBe("https://test.kharagolf.com");
    }

    const [org] = await db.select({
      stamp: organizationsTable.erasureStorageDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(org.stamp).toBe(new Date().toISOString().slice(0, 10));
  });

  it("does not double-send on the same UTC day across repeated invocations", async () => {
    const orgId = await makeOrg("dedup");
    const memberId = await makeMember(orgId);
    await recordStuckErasure(orgId, memberId, 1);
    await makeController(orgId, "org_admin", `dedup-${orgId}@example.com`, "Dedup Admin");

    await sendErasureStorageFailuresDigest();
    const firstRunCalls = emailMock.mock.calls.filter(
      ([arg]) => arg.to === `dedup-${orgId}@example.com`,
    ).length;
    expect(firstRunCalls).toBe(1);

    emailMock.mockClear();
    await sendErasureStorageFailuresDigest();
    const secondRunCalls = emailMock.mock.calls.filter(
      ([arg]) => arg.to === `dedup-${orgId}@example.com`,
    ).length;
    expect(secondRunCalls).toBe(0);
  });

  it("renders the privacy dashboard link in the email body", async () => {
    // Un-mock the mailer just for the template assertion, and intercept the
    // pluggable email adapter so no real SMTP is hit.
    vi.resetModules();
    vi.doMock("../lib/mailer.js", async (importActual) => {
      const actual = await importActual<typeof import("../lib/mailer.js")>();
      return actual;
    });
    const sendTxnMock = vi.fn(async () => ({ ok: true, provider: "test", messageId: "abc" }));
    vi.doMock("../lib/email/adapter.js", async (importActual) => {
      const actual = await importActual<typeof import("../lib/email/adapter.js")>();
      return {
        ...actual,
        sendTransactionalEmail: sendTxnMock,
        getActiveMailProvider: () => ({ name: "test", isConfigured: () => true }),
      };
    });

    const mailer = await import("../lib/mailer.js");
    await mailer.sendErasureStorageFailuresDigestEmail({
      to: "deeplink@example.com",
      staffName: "Deep Link Controller",
      baseUrl: "https://test.kharagolf.com",
      count: 1,
      totalFailedFiles: 4,
      pendingStorageDeletions: { total: 5, exhausted: 2 },
      items: [{
        clubMemberId: 9999,
        auditId: 12345,
        completedAt: new Date().toISOString(),
        objectStorageFilesFailed: 4,
        memberFirstName: "Deep",
        memberLastName: "Link",
        memberNumber: "M-42",
        memberDeleted: false,
      }],
    });

    expect(sendTxnMock).toHaveBeenCalledTimes(1);
    const sendArg = (sendTxnMock.mock.calls[0] as unknown as Array<{ html: string; subject: string }>)[0];
    expect(sendArg.html).toContain("https://test.kharagolf.com/privacy?panel=erasure-storage-failures");
    expect(sendArg.html).toContain("https://test.kharagolf.com/members/9999?panel=erasure-history");
    expect(sendArg.html).toContain("Deep Link");
    expect(sendArg.html).toContain("M-42");
    expect(sendArg.html).toContain("exhausted the bounded backoff");
    expect(sendArg.subject).toContain("stuck erasure cleanup");

    vi.doUnmock("../lib/email/adapter.js");
    vi.doUnmock("../lib/mailer.js");
    vi.resetModules();
  });

  // ── Task #1241 — in-app inbox row + push dispatch ─────────────────────
  it("dispatches an in-app inbox row + push to every controller for the org when count > 0", async () => {
    const orgId = await makeOrg("dispatch");
    const memberId = await makeMember(orgId, "DispatchOne");
    await recordStuckErasure(orgId, memberId, 2);

    const adminId = await makeController(orgId, "org_admin", `disp-admin-${orgId}@example.com`, "Disp Admin");
    const msId = await makeController(orgId, "membership_secretary", `disp-ms-${orgId}@example.com`, "Disp MS");
    const trId = await makeController(orgId, "treasurer", `disp-tr-${orgId}@example.com`, "Disp Treasurer");

    await sendErasureStorageFailuresDigest();

    const callsForOrg = dispatchMock.mock.calls.filter(
      ([, userIds]) => userIds.some(uid => [adminId, msId, trId].includes(uid)),
    );
    expect(callsForOrg).toHaveLength(1);
    const [key, userIds, payload] = callsForOrg[0];
    expect(key).toBe("privacy.erasure.storage_failures.controller_digest");
    expect(new Set(userIds)).toEqual(new Set([adminId, msId, trId]));
    expect(payload.title).toContain("stuck erasure cleanup");
    expect(payload.body).toContain("2 object-storage files");
    expect((payload.data as { url?: string } | undefined)?.url)
      .toBe("https://test.kharagolf.com/privacy?panel=erasure-storage-failures");
    expect((payload.data as { deepLink?: string } | undefined)?.deepLink)
      .toBe("/privacy?panel=erasure-storage-failures");
    expect((payload.data as { type?: string } | undefined)?.type)
      .toBe("privacy_erasure_storage_failures_digest");
    expect((payload.data as { organizationId?: number } | undefined)?.organizationId).toBe(orgId);
    expect((payload.data as { count?: number } | undefined)?.count).toBe(1);
    expect(payload.branding?.orgId).toBe(orgId);
  });

  it("dispatches in-app to controllers without an email on file (push-only audience)", async () => {
    const orgId = await makeOrg("noemail");
    const memberId = await makeMember(orgId, "NoEmailStuck");
    await recordStuckErasure(orgId, memberId, 1);

    // Email controller — gets both email + dispatch.
    const emailUserId = await makeController(orgId, "org_admin", `ne-email-${orgId}@example.com`, "Email Admin");
    // Push-only controller — no email on file. Must still appear in dispatch.
    const noEmailUserId = await makeUser({ email: null, displayName: "PushOnly Treasurer" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: noEmailUserId, role: "treasurer" });

    await sendErasureStorageFailuresDigest();

    // Email recipient gets the email.
    const emailedTo = emailMock.mock.calls
      .map(([arg]) => arg.to)
      .filter(to => to === `ne-email-${orgId}@example.com`);
    expect(emailedTo).toHaveLength(1);

    // Both controllers — including the push-only one — receive the dispatch.
    const callsForOrg = dispatchMock.mock.calls.filter(
      ([, userIds]) => userIds.some(uid => [emailUserId, noEmailUserId].includes(uid)),
    );
    expect(callsForOrg).toHaveLength(1);
    const [, userIds] = callsForOrg[0];
    expect(new Set(userIds)).toEqual(new Set([emailUserId, noEmailUserId]));
  });

  it("does not double-dispatch on the same UTC day (mirrors the email watermark)", async () => {
    const orgId = await makeOrg("dispdedup");
    const memberId = await makeMember(orgId);
    await recordStuckErasure(orgId, memberId, 1);
    const userId = await makeController(orgId, "org_admin", `dd-${orgId}@example.com`, "DD Admin");

    await sendErasureStorageFailuresDigest();
    const firstRun = dispatchMock.mock.calls.filter(
      ([, ids]) => ids.includes(userId),
    ).length;
    expect(firstRun).toBe(1);

    dispatchMock.mockClear();
    await sendErasureStorageFailuresDigest();
    const secondRun = dispatchMock.mock.calls.filter(
      ([, ids]) => ids.includes(userId),
    ).length;
    expect(secondRun).toBe(0);
  });

  it("does not dispatch when the org has zero stuck erasures", async () => {
    const orgId = await makeOrg("dispzero");
    const memberId = await makeMember(orgId);
    const userId = await makeController(orgId, "org_admin", `dz-${orgId}@example.com`, "DZ Admin");
    await recordStuckErasure(orgId, memberId, 0);

    await sendErasureStorageFailuresDigest();

    const callsForOrg = dispatchMock.mock.calls.filter(
      ([, ids]) => ids.includes(userId),
    );
    expect(callsForOrg).toHaveLength(0);
  });
});
