/**
 * Integration tests for Task #1506 — admin override of a member's channel
 * notification preferences (`preferEmail`, `preferPush`, `preferSms`,
 * `preferWhatsapp`) alongside the existing `notifySideGameReceipts` flag.
 *
 * Endpoint: PUT /api/organizations/:orgId/members/:userId/notification-prefs
 *
 * Covers:
 *   1. 400 when the body has no toggleable fields at all.
 *   2. 400 when one of the channel fields is sent as a non-boolean.
 *   3. 200 + persisted change + audit row when an admin flips a single
 *      channel (e.g. `preferSms`) on the upsert path.
 *   4. 200 + persisted change + audit row covering every diff when an admin
 *      flips multiple channels in one request.
 *   5. Unspecified fields are left unchanged across calls.
 *   6. notifySideGameReceipts can be combined with channel changes in a
 *      single request and still produces one audit row whose fieldChanges
 *      lists every diff.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let adminId: number;
let memberUserId: number;
let memberClubId: number;

beforeAll(async () => {
  const tag = uid("admin-channel-toggle");

  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    displayName: "Admin",
    email: `${tag}-admin@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [mem] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-member`,
    username: `${tag}_member`,
    displayName: "Target Member",
    email: `${tag}-member@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = mem.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: adminId, role: "org_admin" },
    { organizationId: orgId, userId: memberUserId, role: "player" },
  ]);

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: memberUserId,
    firstName: "Target",
    lastName: "Member",
    email: `${tag}-member@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberClubId = cm.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, orgId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, memberUserId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberClubId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function adminApp() {
  return createTestApp({
    id: adminId,
    username: "admin",
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  });
}

async function latestAudit() {
  const [row] = await db
    .select()
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "comm_prefs"),
      eq(memberAuditLogTable.entityId, memberUserId),
    ))
    .orderBy(desc(memberAuditLogTable.id))
    .limit(1);
  return row;
}

describe("PUT /notification-prefs — channel overrides (Task #1506)", () => {
  it("returns 400 when no toggleable fields are supplied", async () => {
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({ reason: "nothing to flip" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a channel field is sent as a non-boolean", async () => {
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({ preferSms: "yes" });
    expect(res.status).toBe(400);
  });

  it("admin can flip a single channel (preferSms ON, insert path) and the audit row records the diff", async () => {
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({ preferSms: true, reason: "Member asked for SMS by phone" });
    expect(res.status).toBe(200);
    expect(res.body.preferSms).toBe(true);
    // Other fields stay at their schema defaults (insert path).
    expect(res.body.preferEmail).toBe(true);
    expect(res.body.preferPush).toBe(true);
    expect(res.body.preferWhatsapp).toBe(false);
    expect(res.body.notifySideGameReceipts).toBe(true);

    const [prefRow] = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, memberUserId));
    expect(prefRow.preferSms).toBe(true);
    // Untouched columns must keep their schema defaults rather than being
    // forced to null on the insert path.
    expect(prefRow.preferEmail).toBe(true);
    expect(prefRow.preferPush).toBe(true);
    expect(prefRow.preferWhatsapp).toBe(false);
    expect(prefRow.notifySideGameReceipts).toBe(true);

    const audit = await latestAudit();
    expect(audit).toBeDefined();
    expect(audit.action).toBe("update");
    expect(audit.actorUserId).toBe(adminId);
    expect(audit.actorRole).toBe("org_admin");
    expect(audit.clubMemberId).toBe(memberClubId);
    expect(audit.reason).toBe("Member asked for SMS by phone");
    expect(audit.fieldChanges).toMatchObject({
      preferSms: { from: false, to: true },
    });
    // Unrelated channels MUST NOT appear in the diff.
    const diff = audit.fieldChanges as Record<string, unknown>;
    expect(diff.preferEmail).toBeUndefined();
    expect(diff.preferPush).toBeUndefined();
    expect(diff.preferWhatsapp).toBeUndefined();
    expect(diff.notifySideGameReceipts).toBeUndefined();
    expect(audit.metadata).toMatchObject({
      source: "admin_member_toggle",
      targetUserId: memberUserId,
    });
  });

  it("admin can flip multiple channels in one request — audit row enumerates every diff", async () => {
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({ preferEmail: false, preferWhatsapp: true });
    expect(res.status).toBe(200);
    expect(res.body.preferEmail).toBe(false);
    expect(res.body.preferWhatsapp).toBe(true);
    // The previously-toggled SMS preference must remain ON (unspecified
    // fields are left unchanged).
    expect(res.body.preferSms).toBe(true);
    expect(res.body.preferPush).toBe(true);
    expect(res.body.notifySideGameReceipts).toBe(true);

    const [prefRow] = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, memberUserId));
    expect(prefRow.preferEmail).toBe(false);
    expect(prefRow.preferWhatsapp).toBe(true);
    expect(prefRow.preferSms).toBe(true);

    const audit = await latestAudit();
    expect(audit.fieldChanges).toMatchObject({
      preferEmail: { from: true, to: false },
      preferWhatsapp: { from: false, to: true },
    });
    const diff = audit.fieldChanges as Record<string, unknown>;
    expect(diff.preferSms).toBeUndefined();
    expect(diff.preferPush).toBeUndefined();
    expect(diff.notifySideGameReceipts).toBeUndefined();
    // Reason omitted — should be null.
    expect(audit.reason).toBeNull();
  });

  it("records a no-op (from === to) supplied field in the audit row so the call is still attributable", async () => {
    // The current state from the previous test is preferEmail=false. Re-
    // sending preferEmail=false must still produce an audit row with the
    // diff present (matches the original single-field implementation, which
    // always recorded the supplied value even if equal). Treasurers rely on
    // this so accidental "I clicked it twice" actions are still attributable.
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({ preferEmail: false });
    expect(res.status).toBe(200);
    expect(res.body.preferEmail).toBe(false);

    const audit = await latestAudit();
    expect(audit.fieldChanges).toMatchObject({
      preferEmail: { from: false, to: false },
    });
    // Other fields must NOT appear — only the explicitly-supplied field is
    // recorded, even when its value didn't change.
    const diff = audit.fieldChanges as Record<string, unknown>;
    expect(Object.keys(diff)).toEqual(["preferEmail"]);
  });

  it("can combine notifySideGameReceipts with channel toggles in one request", async () => {
    const res = await request(adminApp())
      .put(`/api/organizations/${orgId}/members/${memberUserId}/notification-prefs`)
      .send({
        notifySideGameReceipts: false,
        preferPush: false,
        reason: "Phone-support combined opt-out",
      });
    expect(res.status).toBe(200);
    expect(res.body.notifySideGameReceipts).toBe(false);
    expect(res.body.preferPush).toBe(false);

    const audit = await latestAudit();
    expect(audit.fieldChanges).toMatchObject({
      notifySideGameReceipts: { from: true, to: false },
      preferPush: { from: true, to: false },
    });
    expect(audit.reason).toBe("Phone-support combined opt-out");
  });
});
