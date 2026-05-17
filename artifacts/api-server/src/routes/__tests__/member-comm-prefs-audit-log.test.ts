/**
 * Task #1505 — GET /api/organizations/:orgId/members/:userId/audit-log
 *
 * Pins the contract for the per-member audit-log endpoint that backs the
 * "Notification Preference History" timeline on the admin Players page.
 *
 * Covers:
 *   • 401 when unauthenticated.
 *   • 403 when the caller is an admin of a different org.
 *   • 404 when the target user is not a member of the org.
 *   • Default `entity=comm_prefs` filter only returns comm_prefs rows.
 *   • Cross-org rows for the same user are *not* leaked.
 *   • Rows are returned newest-first.
 *   • `entity=all` returns non-comm_prefs rows for the same user too.
 *   • `limit` is honoured (1..100) and clamps out-of-range values.
 *   • Each row includes the actor's freshest displayName, role, the
 *     fieldChanges before/after diff, and the free-text reason.
 *
 * Task #1852 — extends the contract with optional `from`, `to`, and
 * `actorUserId` query parameters so admins can drill into a specific
 * incident. Tests below cover each filter combination and confirm
 * out-of-range entries are excluded.
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
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminA2Id: number;
let adminBId: number;
let memberId: number;
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
    name: `T1505_A_${stamp}`, slug: `t1505-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;
  orgIds.push(orgAId);

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1505_B_${stamp}`, slug: `t1505-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;
  orgIds.push(orgBId);

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1505-admin-a-${stamp}`,
    username: `t1505_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1505.test`,
    displayName: "Admin Alpha",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;
  userIds.push(adminAId);

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1505-admin-b-${stamp}`,
    username: `t1505_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1505.test`,
    displayName: "Admin Bravo",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;
  userIds.push(adminBId);

  // Task #1852 — second orgA admin so we can test the actor filter.
  const [adminA2] = await db.insert(appUsersTable).values({
    replitUserId: `t1852-admin-a2-${stamp}`,
    username: `t1852_admin_a2_${stamp}`,
    email: `admin_a2_${stamp}@t1852.test`,
    displayName: "Admin Alpha-2",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminA2Id = adminA2.id;
  userIds.push(adminA2Id);

  const [member] = await db.insert(appUsersTable).values({
    replitUserId: `t1505-member-${stamp}`,
    username: `t1505_member_${stamp}`,
    email: `member_${stamp}@t1505.test`,
    displayName: "Mary Member",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  memberId = member.id;
  userIds.push(memberId);

  const [outsideMember] = await db.insert(appUsersTable).values({
    replitUserId: `t1505-outside-${stamp}`,
    username: `t1505_outside_${stamp}`,
    email: `outside_${stamp}@t1505.test`,
    displayName: "Out Sider",
    role: "player",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  outsideMemberId = outsideMember.id;
  userIds.push(outsideMemberId);

  // Memberships: member is in orgA only; outsideMember is in orgB only.
  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgAId, userId: adminA2Id, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
    { organizationId: orgAId, userId: memberId, role: "player" },
    { organizationId: orgBId, userId: outsideMemberId, role: "player" },
  ]);

  // ── Audit rows for the in-org member, in chronological order ──────────
  // Oldest comm_prefs row — admin muted side-game receipts.
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha (snapshot)",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
    reason: "Member requested by phone",
    createdAt: new Date("2026-01-10T09:00:00Z"),
  });
  // Middle row — admin un-muted again.
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: false, to: true } },
    reason: null,
    createdAt: new Date("2026-02-15T11:30:00Z"),
  });
  // Newest comm_prefs row — admin muted again with a reason.
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
    reason: "Asked again at AGM",
    createdAt: new Date("2026-03-20T14:45:00Z"),
  });

  // Same member — but a non-comm_prefs entry that should NOT appear by
  // default (entity filter excludes it).
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    entity: "profile",
    action: "update",
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    actorRole: "org_admin",
    fieldChanges: { displayName: { from: "Old Name", to: "Mary Member" } },
    createdAt: new Date("2026-02-20T10:00:00Z"),
  });

  // Cross-org leak check: a comm_prefs row for the *same userId* in
  // orgB. Must NOT show up when querying orgA.
  await seedAudit({
    orgId: orgBId,
    entityId: memberId,
    actorUserId: adminBId,
    actorName: "Admin Bravo",
    actorRole: "org_admin",
    fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
    reason: "should NOT be visible in orgA",
    createdAt: new Date("2026-04-01T08:00:00Z"),
  });

  // ── Task #1852 — extra rows by a *second* orgA admin so the actor +
  // date-range filters have two distinct actors. Both rows are seeded
  // *before* the existing oldest row (2026-01-10) so the index-based
  // assertions in the Task #1505 tests above continue to hold (newest
  // entry stays the 2026-03-20 row).
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    actorUserId: adminA2Id,
    actorName: "Admin Alpha-2",
    actorRole: "org_admin",
    fieldChanges: { preferEmail: { from: true, to: false } },
    reason: "1852 - alpha-2 muted email in Jan",
    createdAt: new Date("2026-01-05T08:00:00Z"),
  });
  await seedAudit({
    orgId: orgAId,
    entityId: memberId,
    actorUserId: adminA2Id,
    actorName: "Admin Alpha-2",
    actorRole: "org_admin",
    fieldChanges: { preferEmail: { from: false, to: true } },
    reason: "1852 - alpha-2 un-muted email last December",
    createdAt: new Date("2025-12-20T08:00:00Z"),
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
  id: adminAId, username: "t1505_admin_a", role: "org_admin", organizationId: orgAId, displayName: "Admin Alpha",
});
const adminBUser = (): TestUser => ({
  id: adminBId, username: "t1505_admin_b", role: "org_admin", organizationId: orgBId, displayName: "Admin Bravo",
});

describe("GET /organizations/:orgId/members/:userId/audit-log (Task #1505)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`);
    expect(r.status).toBe(401);
  });

  it("forbids admins from a different org", async () => {
    const app = createTestApp(adminBUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`);
    expect(r.status).toBe(403);
  });

  it("returns 404 when the user is not a member of the org", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${outsideMemberId}/audit-log`);
    expect(r.status).toBe(404);
  });

  it("returns only comm_prefs rows by default, newest-first, with no cross-org leak", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`);
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(20);
    expect(Array.isArray(r.body.entries)).toBe(true);
    // 5 comm_prefs rows in orgA (3 from Task #1505 + 2 from Task #1852).
    // The profile row and the orgB row are filtered out.
    expect(r.body.entries).toHaveLength(5);
    // All entries are comm_prefs.
    expect(r.body.entries.every((e: { entity: string }) => e.entity === "comm_prefs")).toBe(true);
    // None of them point at orgB (no leak).
    expect(r.body.entries.some((e: { reason: string | null }) => e.reason?.includes("NOT be visible"))).toBe(false);
    // Newest first.
    const dates = r.body.entries.map((e: { createdAt: string }) => e.createdAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
    // Newest row carries the most recent reason and a from/to diff.
    expect(r.body.entries[0].reason).toBe("Asked again at AGM");
    expect(r.body.entries[0].fieldChanges).toEqual({
      notifySideGameReceipts: { from: true, to: false },
    });
    // Actor display name comes from the live app_users join (Admin Alpha)
    // not the snapshot we wrote on the row at index 2 (the 2026-01-10 row,
    // whose actorName snapshot is "Admin Alpha (snapshot)").
    expect(r.body.entries[2].actorName).toBe("Admin Alpha");
    expect(r.body.entries[0].actorRole).toBe("org_admin");
  });

  it("returns non-comm_prefs rows when entity=all is requested", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log?entity=all`);
    expect(r.status).toBe(200);
    // 5 comm_prefs + 1 profile = 6.
    expect(r.body.entries.length).toBe(6);
    expect(r.body.entries.some((e: { entity: string }) => e.entity === "profile")).toBe(true);
  });

  it("honours an explicit entity filter", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log?entity=profile`);
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
    expect(r.body.entries[0].entity).toBe("profile");
  });

  it("clamps the limit to the requested value", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log?limit=2`);
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(2);
    expect(r.body.entries).toHaveLength(2);
  });

  it("clamps an oversized limit down to 100", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log?limit=9999`);
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(100);
  });
});

describe("GET /organizations/:orgId/members/:userId/audit-log filters (Task #1852)", () => {
  // Reasons for the rows used in these assertions (chronological in orgA):
  //   2025-12-20  Alpha-2  "1852 - alpha-2 un-muted email last December"
  //   2026-01-05  Alpha-2  "1852 - alpha-2 muted email in Jan"
  //   2026-01-10  Alpha    "Member requested by phone"
  //   2026-02-15  Alpha    null
  //   2026-03-20  Alpha    "Asked again at AGM"

  it("exposes the distinct list of actors that have ever touched this member's prefs", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.availableActors)).toBe(true);
    const ids = (r.body.availableActors as Array<{ actorUserId: number }>).map(a => a.actorUserId).sort();
    // Both orgA admins should appear; the orgB admin must NOT leak.
    expect(ids).toEqual([adminAId, adminA2Id].sort((a, b) => a - b));
    expect(ids).not.toContain(adminBId);
    // Display names come from the live join, not the snapshot.
    const alpha = (r.body.availableActors as Array<{ actorUserId: number; actorName: string | null }>).find(
      a => a.actorUserId === adminAId,
    );
    expect(alpha?.actorName).toBe("Admin Alpha");
  });

  it("filters by `from` (inclusive lower bound) and excludes older entries", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ from: "2026-02-01T00:00:00Z" });
    expect(r.status).toBe(200);
    // 2026-02-15 and 2026-03-20 only (the three Jan/Dec rows are excluded).
    expect(r.body.entries).toHaveLength(2);
    const reasons = (r.body.entries as Array<{ reason: string | null }>).map(e => e.reason);
    expect(reasons).toEqual(["Asked again at AGM", null]);
    expect(r.body.appliedFilters).toEqual({
      from: "2026-02-01T00:00:00.000Z",
      to: null,
      actorUserId: null,
    });
  });

  it("filters by `to` (inclusive upper bound) and excludes newer entries", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ to: "2026-01-31T23:59:59Z" });
    expect(r.status).toBe(200);
    // 2025-12-20, 2026-01-05, 2026-01-10 only.
    expect(r.body.entries).toHaveLength(3);
    const dates = (r.body.entries as Array<{ createdAt: string }>).map(e => e.createdAt);
    // Newest-first: 01-10, 01-05, 12-20.
    expect(dates[0]).toBe("2026-01-10T09:00:00.000Z");
    expect(dates[2]).toBe("2025-12-20T08:00:00.000Z");
  });

  it("filters by `from` + `to` (inclusive range) and excludes entries on either side", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({
        from: "2026-01-01T00:00:00Z",
        to: "2026-02-28T23:59:59Z",
      });
    expect(r.status).toBe(200);
    // 2026-01-05, 2026-01-10, 2026-02-15 — Dec 20 and Mar 20 are outside.
    expect(r.body.entries).toHaveLength(3);
    const reasons = (r.body.entries as Array<{ reason: string | null }>)
      .map(e => e.reason)
      .sort();
    expect(reasons).toEqual([
      "1852 - alpha-2 muted email in Jan",
      "Member requested by phone",
      null,
    ].sort());
  });

  it("filters by `actorUserId` and excludes entries from other actors", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ actorUserId: String(adminA2Id) });
    expect(r.status).toBe(200);
    // Only the two Alpha-2 rows.
    expect(r.body.entries).toHaveLength(2);
    expect(
      (r.body.entries as Array<{ actorUserId: number }>).every(e => e.actorUserId === adminA2Id),
    ).toBe(true);
    expect(r.body.appliedFilters.actorUserId).toBe(adminA2Id);
  });

  it("filters by `from` + `to` + `actorUserId` together", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-31T23:59:59Z",
        actorUserId: String(adminA2Id),
      });
    expect(r.status).toBe(200);
    // Only 2026-01-05 (Alpha-2 inside the Jan window).
    expect(r.body.entries).toHaveLength(1);
    expect(r.body.entries[0].actorUserId).toBe(adminA2Id);
    expect(r.body.entries[0].reason).toBe("1852 - alpha-2 muted email in Jan");
    expect(r.body.appliedFilters).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.000Z",
      actorUserId: adminA2Id,
    });
  });

  it("returns an empty list when the range matches no entries (still echoes the filter)", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({
        from: "2027-01-01T00:00:00Z",
        to: "2027-12-31T23:59:59Z",
      });
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([]);
    // availableActors is computed independently of the filter so the UI
    // dropdown stays populated.
    expect((r.body.availableActors as unknown[]).length).toBeGreaterThan(0);
  });

  it("rejects malformed `from`/`to`/`actorUserId` with HTTP 400", async () => {
    const app = createTestApp(adminAUser());
    const bad1 = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ from: "not-a-date" });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ to: "still-not-a-date" });
    expect(bad2.status).toBe(400);
    const bad3 = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({ actorUserId: "abc" });
    expect(bad3.status).toBe(400);
    const bad4 = await request(app)
      .get(`/api/organizations/${orgAId}/members/${memberId}/audit-log`)
      .query({
        from: "2026-03-01T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      });
    expect(bad4.status).toBe(400);
  });
});
