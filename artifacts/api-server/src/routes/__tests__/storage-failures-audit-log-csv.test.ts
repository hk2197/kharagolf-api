/**
 * Task #1896 — GET /organizations/:orgId/members-360/erasures/storage-failures/audit-log.csv
 *
 * Pins the contract for the CSV variant of the storage-cleanup audit list:
 *   • Same auth posture as the JSON sibling (401 / 403).
 *   • Honours the same actor / action / pathPrefix filter triple so the
 *     download is always a faithful slice of what's on screen.
 *   • Cross-org isolation and entity scoping survive the export path.
 *   • Cascade-deleted member rows render as "(removed)" in the member
 *     column rather than dropping the row.
 *   • Live actor join wins over the snapshot stored at the time of the
 *     action; rows with a NULL actor still export.
 *   • Header columns and Content-Disposition match the documented
 *     filename so a downstream consumer can rely on the shape.
 *   • Hard cap of 5000 rows; explicit `?limit=` narrows the export.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

async function ensureSchema() {
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
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
}

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let liveMemberId: number;

const auditIds: number[] = [];
const userIds: number[] = [];
const memberIds: number[] = [];
const orgIds: number[] = [];

beforeAll(async () => {
  await ensureSchema();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1896_A_${stamp}`, slug: `t1896-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id; orgIds.push(orgAId);

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1896_B_${stamp}`, slug: `t1896-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id; orgIds.push(orgBId);

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1896-admin-a-${stamp}`,
    username: `t1896_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1896.test`,
    displayName: "Admin Alpha",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id; userIds.push(adminAId);

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1896-admin-b-${stamp}`,
    username: `t1896_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1896.test`,
    displayName: "Admin Bravo",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id; userIds.push(adminBId);

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
  ]);

  const [liveMember] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Liv", lastName: "Surviving",
    memberNumber: "LIV-001",
    email: `liv_${stamp}@t1896.test`,
  }).returning({ id: clubMembersTable.id });
  liveMemberId = liveMember.id; memberIds.push(liveMemberId);

  // ── Audit fixtures (newest first when ordered by createdAt desc) ─────
  // 1. Newest: force_retry by adminA on the LIVE member's pending row.
  const [a1] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha (snapshot)",
    actorRole: "org_admin",
    entity: "pending_storage_deletion",
    entityId: 9001,
    action: "force_retry",
    metadata: { path: "members/2024-migration/orphan.png", attempts: 8, lastError: "TimeoutError: backend unavailable" },
    reason: null,
    createdAt: new Date("2026-04-25T12:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a1.id);

  // 2. resolve by adminA, with a free-text reason that contains a quote.
  const [a2] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha (snapshot)",
    actorRole: "org_admin",
    entity: "pending_storage_deletion",
    entityId: 9002,
    action: "resolve",
    metadata: { path: "members/2024-migration/resolved.png", attempts: 12 },
    reason: 'Bucket migration: "confirmed delete"',
    createdAt: new Date("2026-04-24T08:30:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a2.id);

  // 3. force_retry on a row whose member was cascade-deleted
  //    (clubMemberId NULL) and whose actor is also gone (NULL).
  const [a3] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: null,
    actorUserId: null,
    actorName: "system",
    actorRole: null,
    entity: "pending_storage_deletion",
    entityId: 9003,
    action: "force_retry",
    metadata: { path: "legacy/cascade-deleted-orphan", attempts: 5 },
    reason: "auto-resolved after cascade",
    createdAt: new Date("2026-04-23T10:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a3.id);

  // 4. NOISE: an unrelated audit row in the same org on a different
  //    entity ("comm_prefs" / "update"). Must NOT leak into the CSV.
  const [a4] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    entity: "comm_prefs",
    entityId: liveMemberId,
    action: "update",
    fieldChanges: { notify: { from: true, to: false } },
    createdAt: new Date("2026-04-26T09:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a4.id);

  // 5. CROSS-ORG: must never appear in orgA's CSV.
  const [a5] = await db.insert(memberAuditLogTable).values({
    organizationId: orgBId,
    clubMemberId: null,
    actorUserId: adminBId,
    actorName: "Admin Bravo",
    entity: "pending_storage_deletion",
    entityId: 9004,
    action: "force_retry",
    metadata: { path: "members/orgB-private/file", attempts: 2 },
    reason: "should NOT leak across orgs",
    createdAt: new Date("2026-04-26T15:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a5.id);
});

afterAll(async () => {
  if (auditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, auditIds));
  }
  if (memberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, memberIds));
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
  id: adminAId, username: "t1896_admin_a", role: "org_admin", organizationId: orgAId, displayName: "Admin Alpha",
});
const adminBUser = (): TestUser => ({
  id: adminBId, username: "t1896_admin_b", role: "org_admin", organizationId: orgBId, displayName: "Admin Bravo",
});

const URL = (q = "") =>
  `/api/organizations/${orgAId}/members-360/erasures/storage-failures/audit-log.csv${q}`;

// Tiny RFC-4180-ish parser sufficient for our quoted CSV output. The
// builder always wraps every cell in double quotes and escapes `"` as
// `""`, so we don't need to handle bare unquoted cells.
function parseCsv(text: string): string[][] {
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
      // ignore
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

describe("GET /erasures/storage-failures/audit-log.csv (Task #1896)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get(URL());
    expect(r.status).toBe(401);
  });

  it("forbids admins from a different org", async () => {
    const app = createTestApp(adminBUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(403);
  });

  it("returns CSV with the documented header and content-disposition", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status, r.text).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toContain(
      `storage-cleanup-audit-org-${orgAId}.csv`,
    );

    const rows = parseCsv(r.text);
    expect(rows[0]).toEqual([
      "audit_id",
      "timestamp",
      "action",
      "admin",
      "admin_email",
      "admin_user_id",
      "member",
      "member_number",
      "club_member_id",
      "path",
      "attempts",
      "reason",
      "last_error",
    ]);
  });

  it("scopes to org + entity, excluding cross-org and unrelated entity rows", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(200);

    const data = parseCsv(r.text).slice(1);
    const ids = data.map(row => row[0]);

    expect(ids).toEqual(expect.arrayContaining([
      String(auditIds[0]), String(auditIds[1]), String(auditIds[2]),
    ]));
    // comm_prefs row in same org excluded.
    expect(ids).not.toContain(String(auditIds[3]));
    // Cross-org row excluded.
    expect(ids).not.toContain(String(auditIds[4]));

    // Cross-org reason text must not appear anywhere in the body.
    expect(r.text).not.toContain("should NOT leak across orgs");
  });

  it("renders cascade-deleted members as '(removed)' and surfaces the live actor join", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(200);

    const data = parseCsv(r.text).slice(1);
    const byId = new Map(data.map(row => [row[0], row]));

    const liveRow = byId.get(String(auditIds[0]));
    expect(liveRow).toBeDefined();
    // admin: live join's displayName, NOT the snapshot text.
    expect(liveRow![3]).toBe("Admin Alpha");
    expect(liveRow![4]).toMatch(/^admin_a_/);
    expect(liveRow![5]).toBe(String(adminAId));
    expect(liveRow![6]).toBe("Liv Surviving");
    expect(liveRow![7]).toBe("LIV-001");
    expect(liveRow![8]).toBe(String(liveMemberId));
    expect(liveRow![9]).toBe("members/2024-migration/orphan.png");
    expect(liveRow![10]).toBe("8");
    expect(liveRow![12]).toBe("TimeoutError: backend unavailable");

    const cascadeRow = byId.get(String(auditIds[2]));
    expect(cascadeRow).toBeDefined();
    // Member column reads "(removed)" with no number / club_member_id.
    expect(cascadeRow![6]).toBe("(removed)");
    expect(cascadeRow![7]).toBe("");
    expect(cascadeRow![8]).toBe("");
    // NULL actor falls back to the snapshot label, no email / user id.
    expect(cascadeRow![3]).toBe("system");
    expect(cascadeRow![4]).toBe("");
    expect(cascadeRow![5]).toBe("");
    expect(cascadeRow![11]).toBe("auto-resolved after cascade");

    // Reason with embedded quote round-trips intact.
    const resolvedRow = byId.get(String(auditIds[1]));
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow![2]).toBe("resolve");
    expect(resolvedRow![11]).toBe('Bucket migration: "confirmed delete"');
  });

  it("honours the actor / action / pathPrefix filters", async () => {
    const app = createTestApp(adminAUser());

    // action=resolve should only return audit row #2.
    const r1 = await request(app).get(URL("?action=resolve"));
    expect(r1.status).toBe(200);
    const ids1 = parseCsv(r1.text).slice(1).map(row => row[0]);
    expect(ids1).toEqual([String(auditIds[1])]);

    // actorUserId=adminA excludes the NULL-actor cascade row.
    const r2 = await request(app).get(URL(`?actorUserId=${adminAId}`));
    expect(r2.status).toBe(200);
    const ids2 = parseCsv(r2.text).slice(1).map(row => row[0]);
    expect(ids2).toEqual(expect.arrayContaining([String(auditIds[0]), String(auditIds[1])]));
    expect(ids2).not.toContain(String(auditIds[2]));

    // pathPrefix=members/2024-migration/ matches rows #1 and #2 only.
    const r3 = await request(app).get(URL("?pathPrefix=members/2024-migration/"));
    expect(r3.status).toBe(200);
    const ids3 = parseCsv(r3.text).slice(1).map(row => row[0]);
    expect(ids3).toEqual(expect.arrayContaining([String(auditIds[0]), String(auditIds[1])]));
    expect(ids3).not.toContain(String(auditIds[2]));
  });

  it("clamps an explicit limit and floors at 1", async () => {
    const app = createTestApp(adminAUser());

    const r1 = await request(app).get(URL("?limit=2"));
    expect(r1.status).toBe(200);
    expect(parseCsv(r1.text).slice(1)).toHaveLength(2);

    const r2 = await request(app).get(URL("?limit=0"));
    expect(r2.status).toBe(200);
    // Floor of 1 — endpoint refuses to return zero rows.
    expect(parseCsv(r2.text).slice(1)).toHaveLength(1);
  });
});
