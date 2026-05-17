/**
 * Integration test: `?entity=` filter on the Member 360 audit-log endpoint
 * (Task #970 / Task #1122).
 *
 * Covers GET /api/organizations/:orgId/members-360/:memberId/audit-log:
 *   - `?entity=data_export` returns only data_export rows (cron-sourced
 *     auto-purge entries) and excludes profile / levy_charge rows from the
 *     same member.
 *   - omitting the parameter (or sending `?entity=all`) returns every row.
 *
 * Guards against a regression where the WHERE clause built in member-360.ts
 * silently drops the entity predicate (e.g. an `if (entityFilter)` typo)
 * which would let the audit dropdown UI claim to be filtering while the
 * server returns the full timeline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let memberId: number;
let admin: TestUser;
const auditIds: number[] = [];

const URL = (q = "") =>
  `/api/organizations/${orgId}/members-360/${memberId}/audit-log${q}`;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AuditEntityFilter_${stamp}`,
    slug: `test-audit-entity-filter-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `audit-entity-filter-admin-${stamp}`,
    username: `audit_entity_filter_admin_${stamp}`,
    email: `audit_entity_filter_admin_${stamp}@example.com`,
    displayName: "Audit Entity Filter Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Filter",
    lastName: "Member",
    email: `filter_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  // Seed three audit rows across three different entities so we can prove
  // the `?entity=data_export` predicate excludes the other two.
  const inserted = await db.insert(memberAuditLogTable).values([
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "system", actorRole: null,
      entity: "data_export", entityId: 9001, action: "purge",
      reason: "expired archive auto-deleted",
      metadata: { source: "cron", artifactUrl: "/objects/data-exports/x.json", alreadyMissing: false },
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "system", actorRole: null,
      entity: "data_export", entityId: 9002, action: "purge",
      reason: "expired archive auto-deleted",
      metadata: { source: "cron", artifactUrl: "/objects/data-exports/y.json", alreadyMissing: true },
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Entity Filter Admin", actorRole: "org_admin",
      entity: "profile", entityId: 1, action: "update",
      reason: "profile updated",
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Entity Filter Admin", actorRole: "org_admin",
      entity: "note", entityId: 1, action: "create",
      reason: "added note",
    },
  ]).returning({ id: memberAuditLogTable.id });
  for (const r of inserted) auditIds.push(r.id);

  admin = {
    id: adminUserId,
    username: `audit_entity_filter_admin_${stamp}`,
    displayName: "Audit Entity Filter Admin",
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  if (auditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, auditIds));
  }
  if (memberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /:memberId/audit-log — ?entity= filter", () => {
  it("returns every row (data_export + profile + note) when no entity filter is supplied", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const entities = new Set(res.body.map((r: { entity: string }) => r.entity));
    expect(entities.has("data_export")).toBe(true);
    expect(entities.has("profile")).toBe(true);
    expect(entities.has("note")).toBe(true);
  });

  it("treats ?entity=all as the unfiltered default", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL("?entity=all"));
    expect(res.status).toBe(200);
    const entities = new Set(res.body.map((r: { entity: string }) => r.entity));
    expect(entities.has("data_export")).toBe(true);
    expect(entities.has("profile")).toBe(true);
    expect(entities.has("note")).toBe(true);
  });

  it("narrows the timeline to only data_export rows when ?entity=data_export is set", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL("?entity=data_export"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    for (const row of res.body) {
      expect(row.entity).toBe("data_export");
      expect(row.action).toBe("purge");
      expect(row.actorName).toBe("system");
      expect(row.metadata).toMatchObject({ source: "cron" });
    }
  });

  it("returns an empty list when filtered to an entity the member has no rows for", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL("?entity=disciplinary"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
