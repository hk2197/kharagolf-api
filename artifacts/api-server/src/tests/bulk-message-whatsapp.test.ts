/**
 * Integration test: Bulk WhatsApp messaging via /members-360/bulk-action (Task #393).
 *
 * Confirms that POST /api/organizations/:orgId/members-360/bulk-action with
 * action="message" and payload.channel="whatsapp" writes:
 *   - one member_messages row per recipient with channel="whatsapp"
 *   - one member_audit_log row per recipient with reason "bulk message (whatsapp)"
 *
 * Guards the new WhatsApp channel against silent regressions in the bulk-action
 * branch (currently in artifacts/api-server/src/routes/member-360.ts ~line 6338).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberMessagesTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let memberIds: number[] = [];
let admin: TestUser;

const URL = () => `/api/organizations/${orgId}/members-360/bulk-action`;

async function clearMessagesAndAudits() {
  if (memberIds.length === 0) return;
  await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.clubMemberId, memberIds));
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "message"),
    inArray(memberAuditLogTable.clubMemberId, memberIds),
  ));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkWhatsApp_${stamp}`,
    slug: `test-bulk-whatsapp-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-wa-admin-${stamp}`,
    username: `bulk_wa_admin_${stamp}`,
    email: `bulk_wa_admin_${stamp}@example.com`,
    displayName: "Bulk WA Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const inserted = await db.insert(clubMembersTable).values([
    { organizationId: orgId, firstName: "Alice", lastName: "M1", email: `alice_${stamp}@ex.com` },
    { organizationId: orgId, firstName: "Bob",   lastName: "M2", email: `bob_${stamp}@ex.com` },
    { organizationId: orgId, firstName: "Cara",  lastName: "M3", email: `cara_${stamp}@ex.com` },
  ]).returning({ id: clubMembersTable.id });
  memberIds = inserted.map(r => r.id);

  admin = {
    id: adminUserId,
    username: `bulk_wa_admin_${stamp}`,
    displayName: "Bulk WA Admin",
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  await clearMessagesAndAudits();
  if (memberIds.length) await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, memberIds));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("POST /members-360/bulk-action — WhatsApp channel (Task #393)", () => {
  it("writes one whatsapp member_messages row + audit row per recipient", async () => {
    await clearMessagesAndAudits();
    const app = createTestApp(admin);

    const res = await request(app).post(URL()).send({
      memberIds,
      action: "message",
      payload: {
        channel: "whatsapp",
        subject: "Test WA",
        body: "Hello via WhatsApp",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(memberIds.length);

    // One whatsapp message row per recipient
    const msgs = await db.select().from(memberMessagesTable)
      .where(inArray(memberMessagesTable.clubMemberId, memberIds));
    expect(msgs.length).toBe(memberIds.length);
    const memberIdsSeen = msgs.map(m => m.clubMemberId).sort();
    expect(memberIdsSeen).toEqual([...memberIds].sort());
    for (const m of msgs) {
      expect(m.channel).toBe("whatsapp");
      expect(m.body).toBe("Hello via WhatsApp");
      expect(m.subject).toBe("Test WA");
      expect(m.organizationId).toBe(orgId);
      expect(m.senderUserId).toBe(adminUserId);
    }

    // One audit row per recipient with reason "bulk message (whatsapp)"
    const audits = await db.select().from(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.entity, "message"),
      inArray(memberAuditLogTable.clubMemberId, memberIds),
    ));
    expect(audits.length).toBe(memberIds.length);
    const auditedMemberIds = audits.map(a => a.clubMemberId).sort();
    expect(auditedMemberIds).toEqual([...memberIds].sort());
    const msgIds = new Set(msgs.map(m => m.id));
    for (const a of audits) {
      expect(a.reason).toBe("bulk message (whatsapp)");
      expect(a.action).toBe("create");
      expect(a.organizationId).toBe(orgId);
      expect(a.actorUserId).toBe(adminUserId);
      expect(a.entityId).not.toBeNull();
      expect(msgIds.has(a.entityId as number)).toBe(true);
    }
  });
});
