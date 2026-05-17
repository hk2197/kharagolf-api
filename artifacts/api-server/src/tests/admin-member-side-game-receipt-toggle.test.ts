/**
 * Integration tests for Task #1272 — admin override of a member's
 * `notifySideGameReceipts` flag.
 *
 * Endpoint: PUT /api/organizations/:orgId/members/:userId/notification-prefs
 *
 * Covers:
 *   1. 401 when unauthenticated.
 *   2. 403 when the caller is a player (no admin/director role anywhere).
 *   3. 403 when the caller is an org_admin in a different org.
 *   4. 400 when the body is missing `notifySideGameReceipts`.
 *   5. 404 when the target user is not a member of the given org.
 *   6. 200 + persisted flip + audit row when an org_admin toggles the flag,
 *      using upsert path (no prior user_notification_prefs row).
 *   7. Subsequent toggle uses the update path and records the previous→new
 *      diff in the audit row's fieldChanges.
 *   8. Audit row links to the matching club_member when one exists.
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

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerUserId: number;
let memberUserId: number;
let memberClubId: number;
let memberWithoutClubRowUserId: number;

beforeAll(async () => {
  const tag = uid("admin-sg-toggle");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `OrgA ${tag}`,
    slug: `${tag}-a`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `OrgB ${tag}`,
    slug: `${tag}-b`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [aAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-a`,
    username: `${tag}_admin_a`,
    displayName: "Admin A",
    email: `${tag}-admin-a@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  adminAId = aAdmin.id;

  const [bAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-b`,
    username: `${tag}_admin_b`,
    displayName: "Admin B",
    email: `${tag}-admin-b@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  adminBId = bAdmin.id;

  const [pl] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-player`,
    username: `${tag}_player`,
    displayName: "Caller Player",
    email: `${tag}-player@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  playerUserId = pl.id;

  const [mem] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-member`,
    username: `${tag}_member`,
    displayName: "Target Member",
    email: `${tag}-member@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = mem.id;

  const [memNoClub] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-member-noclub`,
    username: `${tag}_member_noclub`,
    displayName: "Target Member (no club row)",
    email: `${tag}-member-noclub@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberWithoutClubRowUserId = memNoClub.id;

  // Wire the org-membership rows the requireOrgAdmin guard reads.
  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
    { organizationId: orgAId, userId: playerUserId, role: "player" },
    { organizationId: orgAId, userId: memberUserId, role: "player" },
    { organizationId: orgAId, userId: memberWithoutClubRowUserId, role: "player" },
  ]);

  // The member-with-club-row also has a club_members entry so the audit
  // helper can link the row to it.
  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    userId: memberUserId,
    firstName: "Target",
    lastName: "Member",
    email: `${tag}-member@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberClubId = cm.id;
});

afterAll(async () => {
  // Cleanup in dependency order.
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, orgAId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, memberUserId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, memberWithoutClubRowUserId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberClubId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgAId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgBId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminAId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminBId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberWithoutClubRowUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

describe("PUT /api/organizations/:orgId/members/:userId/notification-prefs", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp(); // no user
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is a player with no admin role", async () => {
    const app = createTestApp({
      id: playerUserId, username: "p", role: "player", organizationId: orgAId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: false });
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller is an org_admin in a different org", async () => {
    // Admin B is admin of orgB only; trying to flip a member in orgA must be rejected.
    const app = createTestApp({
      id: adminBId, username: "ab", role: "org_admin", organizationId: orgBId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: false });
    expect(res.status).toBe(403);
  });

  it("returns 400 when notifySideGameReceipts is missing from the body", async () => {
    const app = createTestApp({
      id: adminAId, username: "aa", role: "org_admin", organizationId: orgAId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ reason: "no body field" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target user is not a member of the org", async () => {
    const app = createTestApp({
      id: adminAId, username: "aa", role: "org_admin", organizationId: orgAId,
    });
    // adminBId belongs to orgB, NOT orgA.
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${adminBId}/notification-prefs`)
      .send({ notifySideGameReceipts: false });
    expect(res.status).toBe(404);
  });

  it("admin can flip the flag off (insert path) and an audit row is recorded", async () => {
    const app = createTestApp({
      id: adminAId, username: "aa", displayName: "Admin A", role: "org_admin", organizationId: orgAId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: false, reason: "Member requested by phone" });
    expect(res.status).toBe(200);
    expect(res.body.notifySideGameReceipts).toBe(false);

    // The user_notification_prefs row was upserted with the new value.
    const [prefRow] = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, memberUserId));
    expect(prefRow.notifySideGameReceipts).toBe(false);

    // The audit row is present, attributes the change, and links the
    // matching club_member when one exists.
    const [auditRow] = await db
      .select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgAId),
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, memberUserId),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow.action).toBe("update");
    expect(auditRow.actorUserId).toBe(adminAId);
    expect(auditRow.actorRole).toBe("org_admin");
    expect(auditRow.clubMemberId).toBe(memberClubId);
    expect(auditRow.reason).toBe("Member requested by phone");
    expect(auditRow.fieldChanges).toMatchObject({
      notifySideGameReceipts: { from: true, to: false },
    });
    expect(auditRow.metadata).toMatchObject({
      source: "admin_member_toggle",
      targetUserId: memberUserId,
    });
  });

  it("subsequent toggle uses the update path and the audit row reflects previous→new diff", async () => {
    const app = createTestApp({
      id: adminAId, username: "aa", displayName: "Admin A", role: "org_admin", organizationId: orgAId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: true });
    expect(res.status).toBe(200);
    expect(res.body.notifySideGameReceipts).toBe(true);

    const [prefRow] = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, memberUserId));
    expect(prefRow.notifySideGameReceipts).toBe(true);

    const [auditRow] = await db
      .select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgAId),
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, memberUserId),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    expect(auditRow.fieldChanges).toMatchObject({
      notifySideGameReceipts: { from: false, to: true },
    });
    // Reason was omitted on this call — audit row should reflect that.
    expect(auditRow.reason).toBeNull();
  });

  it("works when the target has no club_members row — audit row has clubMemberId=null", async () => {
    const app = createTestApp({
      id: adminAId, username: "aa", displayName: "Admin A", role: "org_admin", organizationId: orgAId,
    });
    const res = await request(app)
      .put(`/api/organizations/${orgAId}/members/${memberWithoutClubRowUserId}/notification-prefs`)
      .send({ notifySideGameReceipts: false });
    expect(res.status).toBe(200);
    expect(res.body.notifySideGameReceipts).toBe(false);

    const [auditRow] = await db
      .select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgAId),
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, memberWithoutClubRowUserId),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow.clubMemberId).toBeNull();
  });
});
