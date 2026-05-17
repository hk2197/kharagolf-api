/**
 * Task #1927 — When the Postmark webhook records a fresh bounce for an
 * address that an admin re-enabled in the last 14 days, email the
 * actor admin so they can follow up. Rate-limited per (admin, address)
 * so a flapping mailbox can't spam the admin.
 *
 * Coverage:
 *   - Fires when a recent reenable audit row matches by `oldEmail`.
 *   - Fires when a recent reenable_with_replacement matches by
 *     `replacementEmail`.
 *   - Skips silently when no reenable audit row exists.
 *   - Skips when the matching reenable row was created *after* the
 *     bounce (so the audit can't be the cause of the re-bounce).
 *   - Skips when the audit is older than the 14-day window.
 *   - Rate-limited: a second bounce of the same address inside the
 *     same re-enable cycle is a no-op.
 *   - Re-enabling again resets the cycle: the next bounce notifies.
 *   - Webhook integration: posting a HardBounce to the Postmark
 *     endpoint after a recorded reenable triggers the notify path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { createTestApp, uid } from "./helpers.js";

// Mock the mailer fn we expect to call. `vi.mock` is hoisted to the top of
// the file, so the factory runs before any `const` declaration — we use
// `vi.hoisted` to share the mock fn between the factory and the test bodies.
const { sendReBouncedAfterReenableAdminEmailMock } = vi.hoisted(() => ({
  sendReBouncedAfterReenableAdminEmailMock: vi.fn(
    async (_opts: Record<string, unknown>): Promise<void> => undefined,
  ),
}));
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendReBouncedAfterReenableAdminEmail: sendReBouncedAfterReenableAdminEmailMock,
  };
});

// Import *after* the mock so the helper sees the stubbed function.
const {
  notifyAdminOfReBounceAfterReenable,
  REBOUNCE_NOTIFIED_ACTION,
} = await import("../lib/rebounceAfterReenableNotify.js");

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdEmails: string[] = [];

beforeAll(() => {
  process.env.POSTMARK_WEBHOOK_USER = "pm-user";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "pm-pass";
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  sendReBouncedAfterReenableAdminEmailMock.mockClear();
});

afterAll(async () => {
  if (createdEmails.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.email, createdEmails));
  }
  if (createdOrgIds.length) {
    // Audit rows are scoped per-org; clean both kinds up here.
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `RB_${tag}`, slug: `rb-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeAdmin(email: string): Promise<number> {
  const tag = uid("admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag, username: tag, displayName: `Admin ${tag}`, email, role: "org_admin",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

interface SeedSuppressionOpts {
  orgId: number;
  email: string;
  reason?: string;
  bounceType?: string | null;
  description?: string | null;
}
async function seedSuppression(opts: SeedSuppressionOpts): Promise<number> {
  const [s] = await db.insert(emailSuppressionsTable).values({
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "HardBounce",
    description: opts.description ?? null,
  }).returning({ id: emailSuppressionsTable.id });
  createdEmails.push(opts.email.toLowerCase());
  return s.id;
}

interface SeedReenableOpts {
  orgId: number;
  actorUserId: number | null;
  oldEmail: string;
  replacementEmail?: string;
  /** Override createdAt for "ancient" / "future" tests. */
  createdAt?: Date;
}
async function seedReenable(opts: SeedReenableOpts): Promise<number> {
  const action = opts.replacementEmail ? "reenable_with_replacement" : "reenable";
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: opts.orgId,
    clubMemberId: null,
    actorUserId: opts.actorUserId,
    actorName: "Test Admin",
    actorRole: "site_admin",
    entity: "email_suppression",
    entityId: null,
    action,
    fieldChanges: opts.replacementEmail
      ? { email: { from: opts.oldEmail, to: opts.replacementEmail } }
      : null,
    reason: `seed re-enable for ${opts.oldEmail}`,
    metadata: {
      oldEmail: opts.oldEmail,
      ...(opts.replacementEmail ? { replacementEmail: opts.replacementEmail } : {}),
    },
    ipAddress: null,
    userAgent: null,
  }).returning({ id: memberAuditLogTable.id });

  if (opts.createdAt) {
    await db.update(memberAuditLogTable)
      .set({ createdAt: opts.createdAt })
      .where(eq(memberAuditLogTable.id, row.id));
  }
  return row.id;
}

async function countMarkers(orgId: number, email: string): Promise<number> {
  const lower = email.toLowerCase();
  const rows = await db.select({ id: memberAuditLogTable.id })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "email_suppression"),
      eq(memberAuditLogTable.action, REBOUNCE_NOTIFIED_ACTION),
      sql`${memberAuditLogTable.metadata}->>'email' = ${lower}`,
    ));
  return rows.length;
}

describe("notifyAdminOfReBounceAfterReenable", () => {
  it("emails the actor admin when a recent reenable matches by oldEmail", async () => {
    const orgId = await makeOrg("ok");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;

    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId,
      email: targetEmail,
      suppressionId,
      bounceType: "HardBounce",
      description: "User unknown",
    });
    expect(result.status).toBe("sent");
    expect(result.adminUserId).toBe(adminId);
    expect(sendReBouncedAfterReenableAdminEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendReBouncedAfterReenableAdminEmailMock.mock.calls[0]?.[0] as unknown as {
      to: string; reboundedEmail: string; bounceType: string | null;
      reenableHadReplacement: boolean; suppressionsUrl: string;
    };
    expect(arg.to).toBe(adminEmail);
    expect(arg.reboundedEmail).toBe(targetEmail);
    expect(arg.bounceType).toBe("HardBounce");
    expect(arg.reenableHadReplacement).toBe(false);
    expect(arg.suppressionsUrl).toMatch(/\/marketing$/);
    expect(await countMarkers(orgId, targetEmail)).toBe(1);
  });

  it("matches by replacementEmail and reports the replacement flag", async () => {
    const orgId = await makeOrg("rep");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const oldEmail = `old-${uid("e")}@example.com`;
    const replacementEmail = `new-${uid("e")}@example.com`;

    await seedReenable({ orgId, actorUserId: adminId, oldEmail, replacementEmail });
    const suppressionId = await seedSuppression({ orgId, email: replacementEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId,
      email: replacementEmail,
      suppressionId,
      bounceType: "BadMailbox",
      description: null,
    });
    expect(result.status).toBe("sent");
    const arg = sendReBouncedAfterReenableAdminEmailMock.mock.calls[0]?.[0] as unknown as {
      reboundedEmail: string; reenableHadReplacement: boolean;
    };
    expect(arg.reboundedEmail).toBe(replacementEmail);
    expect(arg.reenableHadReplacement).toBe(true);
  });

  it("skips when no recent reenable audit row exists", async () => {
    const orgId = await makeOrg("none");
    const adminEmail = `admin-${uid("a")}@example.com`;
    await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId,
      email: targetEmail,
      suppressionId,
      bounceType: "HardBounce",
      description: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recent_reenable");
    expect(sendReBouncedAfterReenableAdminEmailMock).not.toHaveBeenCalled();
    expect(await countMarkers(orgId, targetEmail)).toBe(0);
  });

  it("skips when the audit row predates the 14-day lookback", async () => {
    const orgId = await makeOrg("old");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;
    // 30 days ago — well outside the window.
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail, createdAt: ancient });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId,
      email: targetEmail,
      suppressionId,
      bounceType: "HardBounce",
      description: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recent_reenable");
    expect(sendReBouncedAfterReenableAdminEmailMock).not.toHaveBeenCalled();
  });

  it("skips when the matching reenable was created after the bounce", async () => {
    const orgId = await makeOrg("future");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;
    // Audit is 1 hour in the future relative to the bounce time we'll pass.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail, createdAt: future });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId,
      email: targetEmail,
      suppressionId,
      bounceType: "HardBounce",
      description: null,
      bouncedAt: new Date(),
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recent_reenable");
  });

  it("rate-limits a second bounce of the same address inside the same cycle", async () => {
    const orgId = await makeOrg("rl");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;

    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const r1 = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId, email: targetEmail, suppressionId,
      bounceType: "HardBounce", description: null,
    });
    expect(r1.status).toBe("sent");

    sendReBouncedAfterReenableAdminEmailMock.mockClear();

    const r2 = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId, email: targetEmail, suppressionId,
      bounceType: "HardBounce", description: null,
    });
    expect(r2.status).toBe("skipped");
    expect(r2.reason).toBe("rate_limited");
    expect(sendReBouncedAfterReenableAdminEmailMock).not.toHaveBeenCalled();
    // Marker count stays at 1 — we don't double-write.
    expect(await countMarkers(orgId, targetEmail)).toBe(1);
  });

  it("re-enabling again starts a new cycle and the next bounce notifies", async () => {
    const orgId = await makeOrg("cycle");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;

    // First cycle: re-enable 2 days ago (older than the marker we'll write next).
    await seedReenable({
      orgId, actorUserId: adminId, oldEmail: targetEmail,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });
    const r1 = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId, email: targetEmail, suppressionId,
      bounceType: "HardBounce", description: null,
    });
    expect(r1.status).toBe("sent");
    expect(await countMarkers(orgId, targetEmail)).toBe(1);

    // Second cycle: admin re-enables again now.
    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail });

    sendReBouncedAfterReenableAdminEmailMock.mockClear();

    const r2 = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId, email: targetEmail, suppressionId,
      bounceType: "HardBounce", description: null,
    });
    expect(r2.status).toBe("sent");
    expect(sendReBouncedAfterReenableAdminEmailMock).toHaveBeenCalledTimes(1);
    expect(await countMarkers(orgId, targetEmail)).toBe(2);
  });

  it("returns no_admin when the matching audit row has no actor", async () => {
    const orgId = await makeOrg("noactor");
    const targetEmail = `target-${uid("e")}@example.com`;
    await seedReenable({ orgId, actorUserId: null, oldEmail: targetEmail });
    const suppressionId = await seedSuppression({ orgId, email: targetEmail });

    const result = await notifyAdminOfReBounceAfterReenable({
      organizationId: orgId, email: targetEmail, suppressionId,
      bounceType: "HardBounce", description: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_admin");
    expect(sendReBouncedAfterReenableAdminEmailMock).not.toHaveBeenCalled();
  });
});

describe("Postmark webhook → re-bounce admin notify integration", () => {
  function basicAuth(user: string, pass: string): string {
    return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  it("triggers the notify path on a HardBounce for a recently re-enabled address", async () => {
    const orgId = await makeOrg("wh");
    const adminEmail = `admin-${uid("a")}@example.com`;
    const adminId = await makeAdmin(adminEmail);
    const targetEmail = `target-${uid("e")}@example.com`;
    // Bind the recipient to the org so the webhook resolves orgIds.
    const tag = uid("u");
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: tag, username: tag, email: targetEmail, role: "player",
    }).returning({ id: appUsersTable.id });
    createdUserIds.push(u.id);
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: u.id, role: "player" });
    await seedReenable({ orgId, actorUserId: adminId, oldEmail: targetEmail });
    createdEmails.push(targetEmail.toLowerCase());

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: targetEmail,
        MessageID: "rb-1",
        Description: "User unknown",
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(sendReBouncedAfterReenableAdminEmailMock).toHaveBeenCalledTimes(1);
    expect(await countMarkers(orgId, targetEmail)).toBe(1);
  });
});
