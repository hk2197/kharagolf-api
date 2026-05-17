/**
 * Tests for Task #1773 — public data-export-expiring unsubscribe link
 * mirrors the Task #1454 erasure-digest pattern:
 *   - Hitting /api/public/data-export-reminder-unsubscribe writes a
 *     comm_prefs audit row with a from→true / to→false fieldChanges
 *     entry, metadata.source = "public_unsubscribe_link", and
 *     metadata.kind = "data_export_expiring".
 *   - The idempotent second click does NOT write a duplicate audit row
 *     (the early-return on alreadyOptedOut short-circuits before the
 *     audit write).
 *   - GET /api/portal/notification-preferences exposes the most recent
 *     link-driven change as
 *     `notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt` plus a
 *     `...Direction` field, and returns null for both when the user has
 *     never used the email link.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(): Promise<string> { throw new Error("disabled"); }
    async getObjectEntityFile(): Promise<never> { throw new Error("disabled"); }
  },
}));

import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdRequestIds: number[] = [];

let auditedOrgId: number;
let auditedUserId: number;
let auditedMemberId: number;
let auditedRequestId: number;
let neverClickedUserId: number;

const TOKEN = `data-export-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function ensureSchema() {
  // The unsubscribe handler reads/writes these columns and the audit
  // table. Mirrors the ALTERs in the sibling tests so the suite still
  // runs against older test DBs that pre-date the migration.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_unsub_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_opted_out_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_notice_sent_at timestamptz`);
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS member_data_requests_expiring_reminder_unsub_token_idx ON member_data_requests(expiring_reminder_unsub_token)`);
  } catch {/* concurrent creation from sibling test — fine */}
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
}

beforeAll(async () => {
  await ensureSchema();

  const tag = uid("data-export-link-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `DataExportLinkAuditOrg_${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  auditedOrgId = org.id;
  createdOrgIds.push(org.id);

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-member`,
    username: `${tag}_member`,
    displayName: "Audited Member",
    email: `${tag}-member@example.com`,
    role: "player",
    organizationId: auditedOrgId,
  }).returning({ id: appUsersTable.id });
  auditedUserId = user.id;
  createdUserIds.push(user.id);

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: auditedOrgId,
    firstName: "Audited",
    lastName: "Member",
    email: `${tag}-member@example.com`,
    userId: auditedUserId,
  }).returning({ id: clubMembersTable.id });
  auditedMemberId = member.id;
  createdMemberIds.push(member.id);

  const [reqRow] = await db.insert(memberDataRequestsTable).values({
    organizationId: auditedOrgId,
    clubMemberId: auditedMemberId,
    requestType: "access",
    status: "completed",
    requestedAt: new Date(),
    artifactUrl: "/objects/exports/audit-test.json",
    expiringReminderUnsubToken: TOKEN,
  }).returning({ id: memberDataRequestsTable.id });
  auditedRequestId = reqRow.id;
  createdRequestIds.push(reqRow.id);

  // A second user who never clicks the link — used to assert the portal
  // GET returns null hint fields.
  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-clean`,
    username: `${tag}_clean`,
    displayName: "Never Clicked",
    email: `${tag}-clean@example.com`,
    role: "player",
    organizationId: auditedOrgId,
  }).returning({ id: appUsersTable.id });
  neverClickedUserId = u2.id;
  createdUserIds.push(u2.id);
});

afterAll(async () => {
  if (createdRequestIds.length) {
    await db.delete(memberDataRequestsTable).where(inArray(memberDataRequestsTable.id, createdRequestIds));
  }
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("Task #1773 — data-export-expiring unsubscribe link writes member_audit_log", () => {
  it("records a comm_prefs audit row with from→to fieldChanges on first click", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get("/api/public/data-export-reminder-unsubscribe")
      .query({ token: TOKEN });
    expect(res.status).toBe(200);

    const auditRows = await db.select({
      entity: memberAuditLogTable.entity,
      action: memberAuditLogTable.action,
      entityId: memberAuditLogTable.entityId,
      organizationId: memberAuditLogTable.organizationId,
      clubMemberId: memberAuditLogTable.clubMemberId,
      fieldChanges: memberAuditLogTable.fieldChanges,
      metadata: memberAuditLogTable.metadata,
      reason: memberAuditLogTable.reason,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, auditedUserId),
        eq(memberAuditLogTable.organizationId, auditedOrgId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.action).toBe("update");
    expect(row.clubMemberId).toBe(auditedMemberId);
    expect(row.reason).toBe("Public unsubscribe link clicked");
    expect(row.fieldChanges).toEqual({
      notifyDataExportExpiring: { from: true, to: false },
    });
    expect(row.metadata).toMatchObject({
      source: "public_unsubscribe_link",
      kind: "data_export_expiring",
      direction: "unsubscribe",
      dataRequestId: auditedRequestId,
      targetUserId: auditedUserId,
    });
  });

  it("does NOT write a duplicate audit row on the idempotent second click", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get("/api/public/data-export-reminder-unsubscribe")
      .query({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, alreadyOptedOut: true });

    const auditRows = await db.select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, auditedUserId),
        eq(memberAuditLogTable.organizationId, auditedOrgId),
      ));
    // First click already wrote one row; the second click must not append.
    expect(auditRows).toHaveLength(1);
  });
});

describe("Task #1773 — portal GET notification-preferences exposes the link-change hint", () => {
  it("returns the timestamp + direction of the most recent link-driven change", async () => {
    const portal = createTestApp({ id: auditedUserId, username: "audited", role: "player" });
    const res = await request(portal).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(typeof res.body.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt).toBe("string");
    // ISO 8601 string
    expect(res.body.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(res.body.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection).toBe("unsubscribe");
  });

  it("returns null hint fields for a member who has never used the email link", async () => {
    const portal = createTestApp({ id: neverClickedUserId, username: "clean", role: "player" });
    const res = await request(portal).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt).toBeNull();
    expect(res.body.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection).toBeNull();
  });
});
