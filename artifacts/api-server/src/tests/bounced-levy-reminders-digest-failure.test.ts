/**
 * Task #1444 — bounced-levy reminders cron failure handling. Unlike
 * the per-levy and org-wide ledger digests, the bounced reminders cron
 * has no JSON recipient list to persist (admins are derived from RBAC
 * roles each tick). The helper is therefore used purely to filter out
 * suppressed admin addresses, and `levy.reminders.digest.failed` is
 * dispatched when:
 *   - every admin's email address is on the suppression list
 *     (status="skipped", nothing went out), OR
 *   - every non-paused recipient's send threw (status="failed").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendBouncedLevyDigestEmail: vi.fn(async () => {}),
  };
});

vi.mock("../lib/levyBouncedReminders.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/levyBouncedReminders.js")>();
  return {
    ...actual,
    listOrgIdsWithFailedLevyMessages: vi.fn(async () => [] as number[]),
    getBouncedLeviesForOrg: vi.fn(async () => ({ totalBounced: 0, levies: [] })),
  };
});

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { sendBouncedLevyRemindersDigest } from "../lib/cron.js";
import { sendBouncedLevyDigestEmail } from "../lib/mailer.js";
import {
  listOrgIdsWithFailedLevyMessages,
  getBouncedLeviesForOrg,
} from "../lib/levyBouncedReminders.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";
import { uid } from "./helpers.js";

const sendMock = vi.mocked(sendBouncedLevyDigestEmail);
const listOrgsMock = vi.mocked(listOrgIdsWithFailedLevyMessages);
const getBouncedMock = vi.mocked(getBouncedLeviesForOrg);

let orgId: number;
let adminId: number;
let treasurerId: number;
let nonAdminId: number;

beforeAll(async () => {
  const tag = uid("t1444c");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1444c ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Bounce Reminders Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [treasurer] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-treas`,
    username: `${tag}_treas`,
    email: `treas_${tag}@example.test`,
    displayName: "Bounce Reminders Treasurer",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  treasurerId = treasurer.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: treasurerId, role: "treasurer",
  });

  const [nonAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-player`,
    username: `${tag}_player`,
    email: `player_${tag}@example.test`,
    displayName: "Plain Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonAdminId = nonAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: nonAdminId, role: "player",
  });

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "levy.reminders.digest.failed"));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, treasurerId, nonAdminId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  listOrgsMock.mockClear();
  listOrgsMock.mockResolvedValue([orgId]);
  getBouncedMock.mockClear();
  // Non-empty summary so the cron does not early-return on
  // "totalBounced === 0".
  getBouncedMock.mockResolvedValue({
    totalBounced: 3,
    levies: [{
      levyId: 1,
      levyName: "Annual Subscription",
      bouncedCount: 3,
      members: [],
      // Extra fields the helper may include — kept loose so a future
      // shape extension doesn't require updating this test.
    }] as never,
  });
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "levy.reminders.digest.failed"));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  // Reset the per-org dedup watermark so each test sees the cron as
  // never having fired today.
  await db.update(organizationsTable)
    .set({ bouncedDigestLastSentOn: null, bouncedDigestFrequency: "daily", bouncedDigestHourLocal: null, bouncedDigestTimezone: null })
    .where(eq(organizationsTable.id, orgId));
});

describe("Task #1444 — bounced-levy reminders digest failure handling", () => {
  it("dispatches the failure key and skips every send when every admin email is on the suppression list", async () => {
    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: `admin_${(await loadOrgSlug())}@example.test`, reason: "bounced", bounceType: "HardBounce" },
      { organizationId: orgId, email: `treas_${(await loadOrgSlug())}@example.test`, reason: "bounced", bounceType: "HardBounce" },
    ]);

    await sendBouncedLevyRemindersDigest();
    expect(sendMock).not.toHaveBeenCalled();

    const adminAudit = await loadAuditFor(adminId);
    const treasAudit = await loadAuditFor(treasurerId);
    const playerAudit = await loadAuditFor(nonAdminId);
    expect(adminAudit.length).toBeGreaterThan(0);
    expect(treasAudit.length).toBeGreaterThan(0);
    expect(playerAudit).toHaveLength(0);

    const adminPayload = adminAudit[0].payload as Record<string, unknown>;
    expect(adminPayload.status).toBe("skipped");
    expect(adminPayload.organizationId).toBe(orgId);
    expect((adminPayload.pausedRecipients as string[]).length).toBe(2);
  });

  it("sends to the surviving recipient when only some are suppressed and does NOT raise the failure notification", async () => {
    const slug = await loadOrgSlug();
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId, email: `admin_${slug}@example.test`, reason: "spam_complaint", bounceType: "SpamComplaint",
    });

    await sendBouncedLevyRemindersDigest();
    // Mailer was called for the unsuppressed treasurer only.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const args = sendMock.mock.calls[0]?.[0];
    expect(args?.to).toBe(`treas_${slug}@example.test`);

    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit).toHaveLength(0);
  });

  it("dispatches the failure key with status=failed when every send to a non-paused recipient throws", async () => {
    sendMock.mockImplementation(async () => { throw new Error("Postmark 422 InactiveRecipient"); });

    await sendBouncedLevyRemindersDigest();
    // Both admin + treasurer were attempted; both threw.
    expect(sendMock).toHaveBeenCalledTimes(2);

    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit.length).toBeGreaterThan(0);
    const adminPayload = adminAudit[0].payload as Record<string, unknown>;
    expect(adminPayload.status).toBe("failed");
    expect(String(adminPayload.reason)).toMatch(/Postmark/);
  });

  it("dispatches the failure key when the org has no admin recipients with an email", async () => {
    // Strip emails off both admins so the early-return "no admin
    // recipients with email" branch fires.
    await db.update(appUsersTable).set({ email: null })
      .where(inArray(appUsersTable.id, [adminId, treasurerId]));

    try {
      await sendBouncedLevyRemindersDigest();
      expect(sendMock).not.toHaveBeenCalled();
      // Audit row still goes out — admins without email get push/in-app.
      const adminAudit = await loadAuditFor(adminId);
      expect(adminAudit.length).toBeGreaterThan(0);
      const adminPayload = adminAudit[0].payload as Record<string, unknown>;
      expect(adminPayload.status).toBe("skipped");
      expect(String(adminPayload.reason)).toMatch(/no admin recipients/);
    } finally {
      // Restore so subsequent tests in the file (and other suites) see
      // the original fixture state.
      const slug = await loadOrgSlug();
      await db.update(appUsersTable).set({ email: `admin_${slug}@example.test` }).where(eq(appUsersTable.id, adminId));
      await db.update(appUsersTable).set({ email: `treas_${slug}@example.test` }).where(eq(appUsersTable.id, treasurerId));
    }
  });
});

async function loadOrgSlug(): Promise<string> {
  const [row] = await db.select({ slug: organizationsTable.slug })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  return row.slug;
}

async function loadAuditFor(userId: number) {
  return db.select().from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, userId),
      eq(notificationAuditLogTable.notificationKey, "levy.reminders.digest.failed"),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt));
}
