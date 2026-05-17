/**
 * Task #1851 — CSV exports of the comm_prefs audit history.
 *
 * Pins the contract for the two new CSV endpoints introduced alongside the
 * in-page Players timeline (Task #1505):
 *   • GET /organizations/:orgId/members/audit-log.csv         (org-wide)
 *   • GET /organizations/:orgId/members/:userId/audit-log.csv (per member)
 *
 * Covers:
 *   • Auth + cross-org guards mirror the JSON sibling endpoint.
 *   • Per-member endpoint 404s when the user is not in the org.
 *   • Per-member CSV is scoped to the requested user only.
 *   • Org-wide CSV includes every member but never bleeds across orgs.
 *   • Default `entity=comm_prefs` filter excludes other entities.
 *   • Multi-field audit rows expand into multiple CSV rows (one per field).
 *   • CSV header + content-disposition match the documented filename.
 *   • Reason and before/after values land in the right CSV columns.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let memberOneId: number;
let memberTwoId: number;
let outsideMemberId: number;

const auditIds: number[] = [];
const userIds: number[] = [];
const orgIds: number[] = [];

async function seedAudit(opts: {
  orgId: number;
  entityId: number | null;
  entity?: string;
  action?: string;
  actorUserId?: number | null;
  actorName?: string | null;
  actorRole?: string | null;
  reason?: string | null;
  fieldChanges?: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: Date;
}): Promise<number> {
  const [r] = await db.insert(memberAuditLogTable).values({
    organizationId: opts.orgId,
    clubMemberId: null,
    actorUserId: opts.actorUserId ?? null,
    actorName: opts.actorName ?? null,
    actorRole: opts.actorRole ?? null,
    entity: opts.entity ?? "comm_prefs",
    entityId: opts.entityId,
    action: opts.action ?? "update",
    fieldChanges: opts.fieldChanges ?? null,
    reason: opts.reason ?? null,
    createdAt: opts.createdAt,
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1851_A_${stamp}`, slug: `t1851-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id; orgIds.push(orgAId);

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1851_B_${stamp}`, slug: `t1851-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id; orgIds.push(orgBId);

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1851-admin-a-${stamp}`,
    username: `t1851_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1851.test`,
    displayName: "Admin Alpha",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id; userIds.push(adminAId);

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1851-admin-b-${stamp}`,
    username: `t1851_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1851.test`,
    displayName: "Admin Bravo",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id; userIds.push(adminBId);

  const [memberOne] = await db.insert(appUsersTable).values({
    replitUserId: `t1851-member1-${stamp}`,
    username: `t1851_member1_${stamp}`,
    email: `member1_${stamp}@t1851.test`,
    displayName: "Mary Member",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  memberOneId = memberOne.id; userIds.push(memberOneId);

  const [memberTwo] = await db.insert(appUsersTable).values({
    replitUserId: `t1851-member2-${stamp}`,
    username: `t1851_member2_${stamp}`,
    email: `member2_${stamp}@t1851.test`,
    displayName: "Pat Player",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  memberTwoId = memberTwo.id; userIds.push(memberTwoId);

  const [outsideMember] = await db.insert(appUsersTable).values({
    replitUserId: `t1851-outside-${stamp}`,
    username: `t1851_outside_${stamp}`,
    email: `outside_${stamp}@t1851.test`,
    displayName: "Out Sider",
    role: "player",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  outsideMemberId = outsideMember.id; userIds.push(outsideMemberId);

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
    { organizationId: orgAId, userId: memberOneId, role: "player" },
    { organizationId: orgAId, userId: memberTwoId, role: "player" },
    { organizationId: orgBId, userId: outsideMemberId, role: "player" },
  ]);

  // Member 1 — two comm_prefs rows.
  await seedAudit({
    orgId: orgAId,
    entityId: memberOneId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
    reason: 'Member said "no thanks"',
    createdAt: new Date("2026-01-10T09:00:00Z"),
  });
  // Multi-field row to confirm CSV expansion (one CSV row per field).
  await seedAudit({
    orgId: orgAId,
    entityId: memberOneId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: {
      preferEmail: { from: true, to: false },
      preferSms: { from: false, to: true },
    },
    reason: null,
    createdAt: new Date("2026-02-15T11:30:00Z"),
  });
  // Member 2 — one comm_prefs row.
  await seedAudit({
    orgId: orgAId,
    entityId: memberTwoId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { digestMode: { from: false, to: true } },
    reason: "Switched to digest",
    createdAt: new Date("2026-02-20T08:00:00Z"),
  });
  // Profile entity (default filter must skip).
  await seedAudit({
    orgId: orgAId,
    entityId: memberOneId,
    entity: "profile",
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { displayName: { from: "Old", to: "Mary Member" } },
    createdAt: new Date("2026-02-25T10:00:00Z"),
  });
  // Cross-org row for the same userId — must NOT appear in orgA exports.
  await seedAudit({
    orgId: orgBId,
    entityId: memberOneId,
    actorUserId: adminBId,
    actorName: "Admin Bravo",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
    reason: "should NOT be visible in orgA",
    createdAt: new Date("2026-04-01T08:00:00Z"),
  });
});

afterAll(async () => {
  if (auditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, auditIds));
  }
  if (userIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  }
});

const adminAUser = (): TestUser => ({
  id: adminAId, username: "t1851_admin_a", role: "org_admin", organizationId: orgAId, displayName: "Admin Alpha",
});
const adminBUser = (): TestUser => ({
  id: adminBId, username: "t1851_admin_b", role: "org_admin", organizationId: orgBId, displayName: "Admin Bravo",
});

function parseCsv(text: string): string[][] {
  // Tiny RFC-4180-ish parser sufficient for our quoted CSV output. Our
  // builder always wraps every cell in double quotes and escapes `"` as
  // `""`, so we don't need to handle bare unquoted cells.
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur); cur = "";
    } else if (ch === "\n") {
      row.push(cur); cur = "";
      rows.push(row); row = [];
    } else if (ch === "\r") {
      // ignore — we don't emit CRLF.
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

describe("GET /organizations/:orgId/members/audit-log.csv (Task #1851 org-wide)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/organizations/${orgAId}/members/audit-log.csv`);
    expect(r.status).toBe(401);
  });

  it("forbids admins from a different org", async () => {
    const app = createTestApp(adminBUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/audit-log.csv`);
    expect(r.status).toBe(403);
  });

  it("returns CSV covering both members but no cross-org rows", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/audit-log.csv`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toContain(
      `comm-prefs-audit-org-${orgAId}.csv`,
    );

    const rows = parseCsv(r.text);
    expect(rows[0]).toEqual([
      "Timestamp", "Member User ID", "Member", "Actor", "Role",
      "Entity", "Action", "Field", "Before", "After", "Reason",
    ]);
    const data = rows.slice(1);

    // 1 (memberOne single field) + 2 (memberOne multi-field) + 1 (memberTwo)
    // = 4 data rows. Profile + cross-org rows must be excluded.
    expect(data).toHaveLength(4);

    // No cross-org leakage.
    expect(r.text).not.toContain("should NOT be visible");
    // Profile entity excluded by default.
    expect(data.every(row => row[5] === "comm_prefs")).toBe(true);

    // Both members appear in the org-wide export.
    const memberCol = data.map(row => row[2]);
    expect(memberCol).toContain("Mary Member");
    expect(memberCol).toContain("Pat Player");

    // Multi-field audit row expanded into one CSV row per field.
    const memberOneFields = data
      .filter(row => row[1] === String(memberOneId))
      .map(row => row[7]);
    expect(memberOneFields).toContain("preferEmail");
    expect(memberOneFields).toContain("preferSms");
    expect(memberOneFields).toContain("notifySideGameReceipts");
  });

  it("includes other entities when entity=all is requested", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/audit-log.csv?entity=all`);
    expect(r.status).toBe(200);
    const rows = parseCsv(r.text).slice(1);
    expect(rows.some(row => row[5] === "profile")).toBe(true);
    // Cross-org row still excluded.
    expect(r.text).not.toContain("should NOT be visible");
  });
});

describe("GET /organizations/:orgId/members/:userId/audit-log.csv (Task #1851 per-member)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get(
      `/api/organizations/${orgAId}/members/${memberOneId}/audit-log.csv`,
    );
    expect(r.status).toBe(401);
  });

  it("forbids admins from a different org", async () => {
    const app = createTestApp(adminBUser());
    const r = await request(app).get(
      `/api/organizations/${orgAId}/members/${memberOneId}/audit-log.csv`,
    );
    expect(r.status).toBe(403);
  });

  it("404s when the target is not a member of the org", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(
      `/api/organizations/${orgAId}/members/${outsideMemberId}/audit-log.csv`,
    );
    expect(r.status).toBe(404);
  });

  it("returns only the requested member's rows, with reason + diff intact", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(
      `/api/organizations/${orgAId}/members/${memberOneId}/audit-log.csv`,
    );
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toContain(
      `comm-prefs-audit-org-${orgAId}-user-${memberOneId}.csv`,
    );

    const rows = parseCsv(r.text);
    const data = rows.slice(1);
    // 1 single-field + 2 expanded multi-field rows.
    expect(data).toHaveLength(3);
    // Member-two's row is NOT in the per-member export.
    expect(data.every(row => row[1] === String(memberOneId))).toBe(true);
    // Embedded quote in the reason should round-trip via the parser.
    const reasons = data.map(row => row[10]);
    expect(reasons).toContain('Member said "no thanks"');
    // Sanity check the from/after columns for the side-game row.
    const sideGame = data.find(row => row[7] === "notifySideGameReceipts");
    expect(sideGame).toBeDefined();
    expect(sideGame![8]).toBe("true");
    expect(sideGame![9]).toBe("false");
  });
});
