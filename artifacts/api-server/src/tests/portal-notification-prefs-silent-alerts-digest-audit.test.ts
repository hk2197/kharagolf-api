/**
 * Task #2073 — PATCH /api/portal/notification-preferences writes a
 * `member_audit_log` row when the super admin opts out of (or back into)
 * the weekly silent-failures CSV digest.
 *
 * Until this task the PATCH path silently flipped
 * `notify_silent_alerts_digest` with no record, so a future incident
 * where every super admin had opted out would leave ops with no way to
 * reconstruct who muted the digest or when. The audit row is shaped to
 * mirror the digest-preferences PATCH at the bottom of `portal.ts`
 * (entity = "comm_prefs", entityId = userId, metadata.kind =
 * "silent_alerts_digest") so the existing per-member comm-prefs
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
import { and, eq, desc } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  const tag = uid("portal-silent-alerts-digest-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `Silent Alerts Digest Audit ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Super Admin Audit User",
    email: `${tag}@example.com`,
    role: "super_admin",
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
  // from the schema default (notify_silent_alerts_digest = true) and a
  // clean audit timeline. The audit history UI scopes by orgId + entityId,
  // and so do our assertions below — clearing the rows for THIS user only
  // keeps the suite parallel-safe with other test files.
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "comm_prefs"),
    eq(memberAuditLogTable.entityId, userId),
  ));
});

async function listSilentAlertsAuditRowsForUser() {
  return db
    .select({
      id: memberAuditLogTable.id,
      organizationId: memberAuditLogTable.organizationId,
      actorUserId: memberAuditLogTable.actorUserId,
      entity: memberAuditLogTable.entity,
      entityId: memberAuditLogTable.entityId,
      action: memberAuditLogTable.action,
      fieldChanges: memberAuditLogTable.fieldChanges,
      metadata: memberAuditLogTable.metadata,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "comm_prefs"),
      eq(memberAuditLogTable.entityId, userId),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));
}

describe("Task #2073 — PATCH /api/portal/notification-preferences silent-alerts-digest audit", () => {
  it("writes an audit row when a super admin opts OUT of the weekly silent-failures digest", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySilentAlertsDigest: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifySilentAlertsDigest).toBe(false);

    const rows = await listSilentAlertsAuditRowsForUser();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.organizationId).toBe(orgId);
    expect(row.actorUserId).toBe(userId);
    expect(row.action).toBe("update");
    expect(row.fieldChanges).toEqual({
      notifySilentAlertsDigest: { from: true, to: false },
    });
    expect(row.metadata).toMatchObject({
      source: "portal_notification_preferences",
      scope: "user_level",
      kind: "silent_alerts_digest",
      direction: "unsubscribe",
      targetUserId: userId,
    });
  });

  it("writes an audit row when a super admin opts BACK IN", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // Seed the opted-out state (writes one audit row).
    const off = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySilentAlertsDigest: false });
    expect(off.status).toBe(200);

    // Flip back on.
    const on = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySilentAlertsDigest: true });
    expect(on.status).toBe(200);
    expect(on.body.notifySilentAlertsDigest).toBe(true);

    const rows = await listSilentAlertsAuditRowsForUser();
    // Newest first per the orderBy above.
    expect(rows).toHaveLength(2);
    const resubscribe = rows[0];
    expect(resubscribe.fieldChanges).toEqual({
      notifySilentAlertsDigest: { from: false, to: true },
    });
    expect(resubscribe.metadata).toMatchObject({
      kind: "silent_alerts_digest",
      direction: "resubscribe",
    });
  });

  it("does NOT write an audit row when the supplied value matches the stored value (no-op save)", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // Schema default is true, so PATCHing true on a fresh prefs row is a
    // no-op and must not pollute the timeline with a from=true → to=true row.
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySilentAlertsDigest: true });
    expect(patch.status).toBe(200);
    expect(patch.body.notifySilentAlertsDigest).toBe(true);

    const rows = await listSilentAlertsAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });

  it("does NOT write an audit row when notifySilentAlertsDigest is omitted from the PATCH body", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // PATCHing some other field must not synthesize a silent-alerts-digest
    // audit row (the diff guard requires the field to actually be supplied).
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ preferPush: false });
    expect(patch.status).toBe(200);

    const rows = await listSilentAlertsAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });
});
