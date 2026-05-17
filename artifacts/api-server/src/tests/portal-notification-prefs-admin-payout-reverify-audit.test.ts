/**
 * Task #2141 — PATCH /api/portal/notification-preferences writes a
 * `member_audit_log` row when a coach opts out of (or back into) the
 * courtesy email that fires after an admin manually re-verifies their
 * payout account (`notifyAdminPayoutReverify`, introduced in Task #1724).
 *
 * Until this task the PATCH path silently flipped the column with no
 * record, so a coach who later complained "I never got the courtesy
 * email after the admin re-verified my account" gave support no way to
 * tell whether the coach themselves had muted it. The audit row is
 * shaped to mirror the silent-alerts-digest audit emitted from the same
 * handler (entity = "comm_prefs", entityId = userId, metadata.kind =
 * "admin_payout_reverify") so the existing per-member comm-prefs
 * audit-history UI surfaces it alongside the other digest toggles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  userNotificationPrefsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  // Task #1724 — defensively ensure the per-event opt-out column exists
  // before any insert/select touches it. Mirrors the pattern in
  // `coach-admin-payout-account-reverify-email.test.ts` so this file
  // does not depend on the test runner having already applied the
  // numbered migration `0132_notify_admin_payout_reverify.sql`.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_admin_payout_reverify boolean NOT NULL DEFAULT true`);

  const tag = uid("portal-admin-payout-reverify-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `Admin Payout Reverify Audit ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Coach Audit User",
    email: `${tag}@example.com`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "comm_prefs"),
    eq(memberAuditLogTable.entityId, userId),
  ));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Reset the prefs row + audit trail between tests so each case starts
  // from the schema default (notify_admin_payout_reverify = true) and
  // a clean audit timeline. Scoping the cleanup to THIS user only keeps
  // the suite parallel-safe with other test files that also write
  // `comm_prefs` audit rows.
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "comm_prefs"),
    eq(memberAuditLogTable.entityId, userId),
  ));
});

async function listAdminPayoutReverifyAuditRowsForUser() {
  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      organizationId: memberAuditLogTable.organizationId,
      actorUserId: memberAuditLogTable.actorUserId,
      entity: memberAuditLogTable.entity,
      entityId: memberAuditLogTable.entityId,
      action: memberAuditLogTable.action,
      fieldChanges: memberAuditLogTable.fieldChanges,
      metadata: memberAuditLogTable.metadata,
      ipAddress: memberAuditLogTable.ipAddress,
      userAgent: memberAuditLogTable.userAgent,
      createdAt: memberAuditLogTable.createdAt,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "comm_prefs"),
      eq(memberAuditLogTable.entityId, userId),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));
  // The handler also writes silent-alerts-digest rows; this test only
  // cares about the new admin-payout-reverify ones.
  return rows.filter(r => {
    const md = (r.metadata ?? {}) as { kind?: string };
    return md.kind === "admin_payout_reverify";
  });
}

describe("Task #2141 — PATCH /api/portal/notification-preferences admin-payout-reverify audit", () => {
  it("writes an audit row when a coach opts OUT of the courtesy email", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player", organizationId: orgId });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .set("User-Agent", "PortalUI/2.0 (test)")
      .send({ notifyAdminPayoutReverify: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyAdminPayoutReverify).toBe(false);

    const rows = await listAdminPayoutReverifyAuditRowsForUser();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.organizationId).toBe(orgId);
    expect(row.actorUserId).toBe(userId);
    expect(row.action).toBe("update");
    expect(row.fieldChanges).toEqual({
      notifyAdminPayoutReverify: { from: true, to: false },
    });
    expect(row.metadata).toMatchObject({
      source: "portal_notification_preferences",
      scope: "user_level",
      kind: "admin_payout_reverify",
      direction: "unsubscribe",
      targetUserId: userId,
    });
    // User-agent is captured by `recordMemberAudit`. (req.ip in supertest
    // reflects the loopback address; we only assert the type, not value.)
    expect(row.userAgent).toBe("PortalUI/2.0 (test)");
    expect(typeof row.ipAddress === "string" || row.ipAddress === null).toBe(true);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("writes an audit row when a coach opts BACK IN", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player", organizationId: orgId });

    // Seed the opted-out state (writes one audit row).
    const off = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyAdminPayoutReverify: false });
    expect(off.status).toBe(200);

    // Flip back on.
    const on = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyAdminPayoutReverify: true });
    expect(on.status).toBe(200);
    expect(on.body.notifyAdminPayoutReverify).toBe(true);

    const rows = await listAdminPayoutReverifyAuditRowsForUser();
    // Newest first per the orderBy in the helper above.
    expect(rows).toHaveLength(2);
    const resubscribe = rows[0];
    expect(resubscribe.fieldChanges).toEqual({
      notifyAdminPayoutReverify: { from: false, to: true },
    });
    expect(resubscribe.metadata).toMatchObject({
      kind: "admin_payout_reverify",
      direction: "resubscribe",
    });
  });

  it("does NOT write an audit row when the supplied value matches the stored value (no-op save)", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player", organizationId: orgId });

    // Schema default is true, so PATCHing true on a fresh prefs row is a
    // no-op and must not pollute the timeline with a from=true → to=true row.
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyAdminPayoutReverify: true });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyAdminPayoutReverify).toBe(true);

    const rows = await listAdminPayoutReverifyAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });

  it("does NOT write an audit row when notifyAdminPayoutReverify is omitted from the PATCH body", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "player", organizationId: orgId });

    // PATCHing some other field must not synthesize an admin-payout-reverify
    // audit row (the diff guard requires the field to actually be supplied).
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ preferPush: false });
    expect(patch.status).toBe(200);

    const rows = await listAdminPayoutReverifyAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });
});
