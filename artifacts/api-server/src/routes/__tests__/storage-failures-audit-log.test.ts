/**
 * Task #1529 — GET /organizations/:orgId/members-360/erasures/storage-failures/audit-log
 *
 * Pins the contract for the org-wide audit feed that backs the
 * "Recent storage-cleanup admin actions" panel on the Privacy tab.
 *
 * Behaviours that matter and were untested:
 *   • Only force_retry / resolve actions on the pending_storage_deletion
 *     entity are returned — unrelated audit rows on the same org (e.g.
 *     comm_prefs updates) must NOT leak in.
 *   • Cross-org isolation: a row in another org's pending_storage_deletion
 *     audit trail must never appear in this org's response.
 *   • Cascade-delete survival: rows whose `club_member_id IS NULL` (member
 *     row was cascade-deleted before/after the audit was written) must
 *     still come back from the LEFT JOIN, with `memberDeleted=true`.
 *   • Live actor join: actorDisplayName / actorUsername / actorEmail come
 *     from the joined app_users row (not the snapshot we wrote at the time
 *     of the action), and rows with no actor (system / cron) still return.
 *   • Newest-first ordering and limit clamp (default 50, max 200, min 1).
 *   • AuthZ: 401 unauthenticated, 403 cross-org admin.
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

// Some older test DBs drop `metadata`; make sure it's present before we
// rely on it.  Mirrors the same defensive ALTER in the sibling
// pending-storage-deletions-admin test.
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
    name: `T1529_A_${stamp}`, slug: `t1529-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;
  orgIds.push(orgAId);

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1529_B_${stamp}`, slug: `t1529-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;
  orgIds.push(orgBId);

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1529-admin-a-${stamp}`,
    username: `t1529_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1529.test`,
    displayName: "Admin Alpha",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;
  userIds.push(adminAId);

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1529-admin-b-${stamp}`,
    username: `t1529_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1529.test`,
    displayName: "Admin Bravo",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;
  userIds.push(adminBId);

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
  ]);

  const [liveMember] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Liv", lastName: "Surviving",
    memberNumber: "LIV-001",
    email: `liv_${stamp}@t1529.test`,
  }).returning({ id: clubMembersTable.id });
  liveMemberId = liveMember.id;
  memberIds.push(liveMemberId);

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
    metadata: { path: "/objects/live-member-orphan", attempts: 8, lastError: "TimeoutError" },
    reason: null,
    createdAt: new Date("2026-04-25T12:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a1.id);

  // 2. resolve by adminA, with a reason and member still alive.
  const [a2] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha (snapshot)",
    actorRole: "org_admin",
    entity: "pending_storage_deletion",
    entityId: 9002,
    action: "resolve",
    metadata: { path: "/objects/live-member-resolved", attempts: 12 },
    reason: "Bucket migration confirmed delete",
    createdAt: new Date("2026-04-24T08:30:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a2.id);

  // 3. resolve on a row whose member was cascade-deleted before/with the
  //    audit being written: clubMemberId is NULL on the audit row. The
  //    LEFT JOIN must still surface this row with memberDeleted=true so
  //    the UI can render the "member row removed" badge instead of
  //    silently dropping the trail entry. Also exercises the NULL-actor
  //    branch (system / cron source) so we know the actor LEFT JOIN
  //    doesn't drop rows when no app_users row matches.
  const [a3] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: null,
    actorUserId: null,
    actorName: "system",
    actorRole: null,
    entity: "pending_storage_deletion",
    entityId: 9003,
    action: "force_retry",
    metadata: { path: "/objects/cascade-deleted-orphan", attempts: 5 },
    reason: "auto-resolved after cascade",
    createdAt: new Date("2026-04-23T10:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a3.id);

  // 4. (Task #1893) bulk force_retry — the bulk-retry-now endpoint stamps
  //    metadata.bulk=true on every emitted row so the Privacy tab can
  //    render a "bulk" pill next to the action badge. Per-row endpoints
  //    don't write the key (rows #1-#3 above), so the response should
  //    contain bulk=true here and bulk=false on those rows.
  const [a4] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha (snapshot)",
    actorRole: "org_admin",
    entity: "pending_storage_deletion",
    entityId: 9004,
    action: "force_retry",
    metadata: { path: "/objects/bulk-cleared-orphan", attempts: 4, bulk: true },
    reason: "admin force-retry (bulk)",
    createdAt: new Date("2026-04-22T14:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a4.id);

  // 5. NOISE: an unrelated audit row in the same org on a different
  //    entity ("comm_prefs" / "update"). Must NOT leak into the response.
  const [a5] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    entity: "comm_prefs",
    entityId: liveMemberId,
    action: "update",
    fieldChanges: { notify: { from: true, to: false } },
    createdAt: new Date("2026-04-26T09:00:00Z"), // newer than #1, would lead the list if entity filter was wrong.
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a5.id);

  // 6. NOISE: pending_storage_deletion but with a non-listed action
  //    ("update"). The endpoint hard-codes the [force_retry, resolve]
  //    inArray filter; this row must be excluded.
  const [a6] = await db.insert(memberAuditLogTable).values({
    organizationId: orgAId,
    clubMemberId: liveMemberId,
    actorUserId: adminAId,
    actorName: "Admin Alpha",
    entity: "pending_storage_deletion",
    entityId: 9005,
    action: "update",
    metadata: { path: "/objects/should-be-excluded" },
    createdAt: new Date("2026-04-26T11:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a6.id);

  // 7. CROSS-ORG: a force_retry on a pending_storage_deletion row that
  //    lives in orgB. Must NEVER appear when querying orgA.
  const [a7] = await db.insert(memberAuditLogTable).values({
    organizationId: orgBId,
    clubMemberId: null,
    actorUserId: adminBId,
    actorName: "Admin Bravo",
    entity: "pending_storage_deletion",
    entityId: 9006,
    action: "force_retry",
    metadata: { path: "/objects/orgB-private", attempts: 2 },
    reason: "should NOT leak across orgs",
    createdAt: new Date("2026-04-26T15:00:00Z"),
  }).returning({ id: memberAuditLogTable.id });
  auditIds.push(a7.id);

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
  id: adminAId, username: "t1529_admin_a", role: "org_admin", organizationId: orgAId, displayName: "Admin Alpha",
});
const adminBUser = (): TestUser => ({
  id: adminBId, username: "t1529_admin_b", role: "org_admin", organizationId: orgBId, displayName: "Admin Bravo",
});

const URL = (q = "") =>
  `/api/organizations/${orgAId}/members-360/erasures/storage-failures/audit-log${q}`;

describe("GET /erasures/storage-failures/audit-log (Task #1529)", () => {
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

  it("returns only force_retry / resolve rows on pending_storage_deletion, scoped to the org, newest-first", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status, r.text).toBe(200);

    const ids: number[] = r.body.items.map((i: { id: number }) => i.id);

    // The three legitimate rows must be present.
    expect(ids).toEqual(expect.arrayContaining([
      auditIds[0], auditIds[1], auditIds[2],
    ]));

    // The non-listed action and the comm_prefs row must NOT leak in.
    expect(ids).not.toContain(auditIds[4]); // comm_prefs / update
    expect(ids).not.toContain(auditIds[5]); // pending_storage_deletion / update
    // The orgB row must NOT leak in.
    expect(ids).not.toContain(auditIds[6]);

    // No paths from excluded rows.
    const paths: (string | null)[] = r.body.items.map((i: { path: string | null }) => i.path);
    expect(paths).not.toContain("/objects/should-be-excluded");
    expect(paths).not.toContain("/objects/orgB-private");

    // Newest-first ordering across the three valid rows.
    const valid = r.body.items
      .filter((i: { id: number }) => auditIds.slice(0, 3).includes(i.id));
    const dates: string[] = valid.map((i: { createdAt: string }) => i.createdAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);

    // Surface the action verbatim — must only ever be force_retry / resolve.
    const actions = new Set(r.body.items.map((i: { action: string }) => i.action));
    for (const a of actions) {
      expect(["force_retry", "resolve"]).toContain(a);
    }

    expect(r.body.limit).toBe(50);
    expect(r.body.count).toBe(r.body.items.length);
  });

  it("includes cascade-deleted rows (clubMemberId NULL on audit row) with memberDeleted=true and a path", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(200);

    const cascadeRow = r.body.items.find((i: { id: number }) => i.id === auditIds[2]);
    expect(cascadeRow).toBeTruthy();
    expect(cascadeRow.clubMemberId).toBeNull();
    expect(cascadeRow.memberDeleted).toBe(true);
    expect(cascadeRow.memberFirstName).toBeNull();
    expect(cascadeRow.memberNumber).toBeNull();
    expect(cascadeRow.path).toBe("/objects/cascade-deleted-orphan");
    expect(cascadeRow.attempts).toBe(5);

    // Sanity: the LIVE-member row must NOT be flagged as deleted.
    const liveRow = r.body.items.find((i: { id: number }) => i.id === auditIds[0]);
    expect(liveRow).toBeTruthy();
    expect(liveRow.memberDeleted).toBe(false);
    expect(liveRow.clubMemberId).toBe(liveMemberId);
    expect(liveRow.memberFirstName).toBe("Liv");
    expect(liveRow.memberNumber).toBe("LIV-001");
  });

  it("surfaces actor display name / username / email from the live join, and tolerates a NULL actor", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(200);

    // The "snapshot" actor name on row #1 must NOT win — the live
    // app_users.displayName ("Admin Alpha") is the source of truth.
    const liveRow = r.body.items.find((i: { id: number }) => i.id === auditIds[0]);
    expect(liveRow.actorUserId).toBe(adminAId);
    expect(liveRow.actorDisplayName).toBe("Admin Alpha");
    expect(liveRow.actorUsername).toMatch(/^t1529_admin_a_/);
    expect(liveRow.actorEmail).toMatch(/^admin_a_/);
    // The snapshot text is still surfaced separately (in `actorName`)
    // for forensic diff against the live join.
    expect(liveRow.actorName).toBe("Admin Alpha (snapshot)");

    // Row #2 carries a free-text reason — the endpoint must surface it
    // verbatim so the UI's italic quote renders.
    const resolvedRow = r.body.items.find((i: { id: number }) => i.id === auditIds[1]);
    expect(resolvedRow.reason).toBe("Bucket migration confirmed delete");

    // Row #3 has a NULL actorUserId (system / cron). The LEFT JOIN
    // must still return the row, and the actor* fields must all be
    // null rather than dropping the row.
    const systemRow = r.body.items.find((i: { id: number }) => i.id === auditIds[2]);
    expect(systemRow.actorUserId).toBeNull();
    expect(systemRow.actorDisplayName).toBeNull();
    expect(systemRow.actorUsername).toBeNull();
    expect(systemRow.actorEmail).toBeNull();
    // The actorName snapshot is still preserved.
    expect(systemRow.actorName).toBe("system");
  });

  it("(Task #1893) surfaces metadata.bulk as a boolean — true for bulk-action rows, false for per-row actions", async () => {
    const app = createTestApp(adminAUser());
    const r = await request(app).get(URL());
    expect(r.status).toBe(200);

    // The bulk fixture (a4) must come back with bulk=true so the
    // Privacy tab can render the "bulk" pill next to its action badge.
    const bulkRow = r.body.items.find((i: { id: number }) => i.id === auditIds[3]);
    expect(bulkRow).toBeTruthy();
    expect(bulkRow.bulk).toBe(true);
    // Sanity: the same row's other metadata is still surfaced — bulk
    // is additive, not a replacement for the existing fields.
    expect(bulkRow.path).toBe("/objects/bulk-cleared-orphan");
    expect(bulkRow.attempts).toBe(4);

    // Per-row force_retry (a1) and per-row resolve (a2) must come
    // back with bulk=false — those endpoints don't write the key, and
    // the projection must not mistake "absent" for "true".
    const perRowForceRetry = r.body.items.find((i: { id: number }) => i.id === auditIds[0]);
    expect(perRowForceRetry).toBeTruthy();
    expect(perRowForceRetry.bulk).toBe(false);
    const perRowResolve = r.body.items.find((i: { id: number }) => i.id === auditIds[1]);
    expect(perRowResolve).toBeTruthy();
    expect(perRowResolve.bulk).toBe(false);

    // The cascade-deleted system row (a3) also has no bulk key and
    // must default to false rather than null/undefined.
    const cascadeRow = r.body.items.find((i: { id: number }) => i.id === auditIds[2]);
    expect(cascadeRow).toBeTruthy();
    expect(cascadeRow.bulk).toBe(false);
  });

  it("clamps an explicit limit to the requested value and caps oversized limits to 200", async () => {
    const app = createTestApp(adminAUser());

    const r1 = await request(app).get(URL("?limit=2"));
    expect(r1.status).toBe(200);
    expect(r1.body.limit).toBe(2);
    expect(r1.body.items).toHaveLength(2);

    const r2 = await request(app).get(URL("?limit=99999"));
    expect(r2.status).toBe(200);
    expect(r2.body.limit).toBe(200);

    const r3 = await request(app).get(URL("?limit=0"));
    expect(r3.status).toBe(200);
    // Floor of 1 — endpoint refuses to return zero rows.
    expect(r3.body.limit).toBe(1);
    expect(r3.body.items).toHaveLength(1);
  });

  // Task #1895 — `from` / `to` date range filters applied server-side
  // against member_audit_log.created_at. Fixtures live on three distinct
  // days (2026-04-23, 2026-04-24, 2026-04-25); we slice between them to
  // confirm both endpoints are inclusive and that bare YYYY-MM-DD `to`
  // values are extended to end-of-day.
  describe("from/to date range (Task #1895)", () => {
    it("filters to rows on or after `from`", async () => {
      const app = createTestApp(adminAUser());
      const r = await request(app).get(URL("?from=2026-04-24"));
      expect(r.status, r.text).toBe(200);
      const ids: number[] = r.body.items.map((i: { id: number }) => i.id);
      // April 25 + April 24 rows present, April 23 row excluded.
      expect(ids).toEqual(expect.arrayContaining([auditIds[0], auditIds[1]]));
      expect(ids).not.toContain(auditIds[2]);
      expect(r.body.filters.from).toBe(new Date("2026-04-24").toISOString());
      expect(r.body.filters.to).toBeNull();
    });

    it("filters to rows on or before `to`, treating bare YYYY-MM-DD as end-of-day UTC", async () => {
      const app = createTestApp(adminAUser());
      // 2026-04-24 has an audit at 08:30Z — must be included even though
      // the bare-date value would otherwise resolve to 00:00Z (which would
      // exclude it). The endpoint pushes `to` to 23:59:59.999Z.
      const r = await request(app).get(URL("?to=2026-04-24"));
      expect(r.status).toBe(200);
      const ids: number[] = r.body.items.map((i: { id: number }) => i.id);
      expect(ids).toEqual(expect.arrayContaining([auditIds[1], auditIds[2]]));
      expect(ids).not.toContain(auditIds[0]); // April 25 row excluded.
      expect(r.body.filters.to).toBe(new Date("2026-04-24T23:59:59.999Z").toISOString());
    });

    it("combines from + to into an inclusive window and pairs with the action filter", async () => {
      const app = createTestApp(adminAUser());
      // April 24 only — both endpoints inclusive should yield exactly the
      // resolve row from that day.
      const r = await request(app).get(URL("?from=2026-04-24&to=2026-04-24&action=resolve"));
      expect(r.status).toBe(200);
      const ids: number[] = r.body.items.map((i: { id: number }) => i.id);
      expect(ids).toEqual([auditIds[1]]);
      expect(r.body.filters.action).toBe("resolve");
      expect(r.body.filters.from).toBe(new Date("2026-04-24").toISOString());
      expect(r.body.filters.to).toBe(new Date("2026-04-24T23:59:59.999Z").toISOString());
    });

    it("ignores invalid / unparseable date strings without filtering anything out", async () => {
      const app = createTestApp(adminAUser());
      const r = await request(app).get(URL("?from=not-a-date&to=also-bad"));
      expect(r.status).toBe(200);
      const ids: number[] = r.body.items.map((i: { id: number }) => i.id);
      expect(ids).toEqual(expect.arrayContaining([auditIds[0], auditIds[1], auditIds[2]]));
      expect(r.body.filters.from).toBeNull();
      expect(r.body.filters.to).toBeNull();
    });

    it("returns an empty list (and count=0) when the window misses every row", async () => {
      const app = createTestApp(adminAUser());
      const r = await request(app).get(URL("?from=2026-05-01&to=2026-05-31"));
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(0);
      expect(r.body.items).toEqual([]);
    });
  });

  // ── Task #1894 — cursor pagination ───────────────────────────────────
  // The endpoint used to silently lose history beyond the 200-row cap once
  // an org accumulated weeks of bulk-clear activity. These tests pin the
  // new "Load older" contract: a page-sized request returns a `nextCursor`
  // that, when echoed back, walks strictly older rows and never repeats a
  // row already shown — including when several rows share a createdAt
  // millisecond (the (createdAt, id) tuple is the deterministic key, not
  // createdAt alone).
  describe("cursor pagination (Task #1894)", () => {
    it("returns no nextCursor when the page is shorter than the limit", async () => {
      const app = createTestApp(adminAUser());
      const r = await request(app).get(URL("?limit=200"));
      expect(r.status).toBe(200);
      // Four valid orgA rows (a1-a4), well below the 200 cap.
      expect(r.body.items.length).toBeLessThan(200);
      expect(r.body.nextCursor).toBeNull();
    });

    it("emits a nextCursor when there is more history, and stops paging the moment there isn't", async () => {
      const app = createTestApp(adminAUser());

      // Four valid rows total in orgA (a1, a2, a3, a4). Page 1 of 2 with
      // limit=2 → nextCursor must be present because two more rows exist.
      const p1 = await request(app).get(URL("?limit=2"));
      expect(p1.status).toBe(200);
      expect(p1.body.items).toHaveLength(2);
      expect(typeof p1.body.nextCursor).toBe("string");
      expect(p1.body.nextCursor.length).toBeGreaterThan(0);
      const ids1: number[] = p1.body.items.map((i: { id: number }) => i.id);
      // Newest two: a1 (04-25) then a2 (04-24).
      expect(ids1).toEqual([auditIds[0], auditIds[1]]);

      // Page 2 with the cursor → the remaining two rows (a3, a4). Page 2
      // *exactly* exhausts the underlying set, so nextCursor must be null
      // — the +1 over-fetch in the route is what prevents a spurious
      // cursor on a perfectly-aligned final page.
      const p2 = await request(app).get(URL(`?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`));
      expect(p2.status).toBe(200);
      const ids2: number[] = p2.body.items.map((i: { id: number }) => i.id);
      expect(ids2).toEqual([auditIds[2], auditIds[3]]);
      expect(p2.body.nextCursor).toBeNull();

      // Cross-page de-duplication: ids from page 2 must not overlap page 1.
      for (const id of ids2) expect(ids1).not.toContain(id);
    });

    it("treats a malformed cursor as a fresh first page rather than 400-ing", async () => {
      const app = createTestApp(adminAUser());

      // base64-decodable but not valid JSON.
      const bogus = Buffer.from("not-json", "utf8").toString("base64url");
      const r1 = await request(app).get(URL(`?limit=2&cursor=${encodeURIComponent(bogus)}`));
      expect(r1.status).toBe(200);
      expect(r1.body.items).toHaveLength(2);
      // Same first-page contents as if no cursor was supplied.
      expect(r1.body.items.map((i: { id: number }) => i.id)).toEqual([
        auditIds[0], auditIds[1],
      ]);

      // Not even base64.
      const r2 = await request(app).get(URL("?limit=2&cursor=%21%21%21"));
      expect(r2.status).toBe(200);
      expect(r2.body.items).toHaveLength(2);

      // Wrong shape (missing id).
      const wrongShape = Buffer.from(JSON.stringify({ t: "2026-04-25T12:00:00.000Z" }), "utf8")
        .toString("base64url");
      const r3 = await request(app).get(URL(`?limit=2&cursor=${encodeURIComponent(wrongShape)}`));
      expect(r3.status).toBe(200);
      expect(r3.body.items).toHaveLength(2);
    });

    it("composite (createdAt, id) cursor breaks ties on identical createdAt and never repeats rows", async () => {
      const app = createTestApp(adminAUser());

      // Insert two rows with the same createdAt millisecond inside orgA.
      // Ordering for these two should be id-DESC (newer id first), and the
      // cursor must walk the older one even though createdAt didn't change.
      const sharedTs = new Date("2026-04-22T01:23:45.678Z");
      const [tieA] = await db.insert(memberAuditLogTable).values({
        organizationId: orgAId,
        clubMemberId: liveMemberId,
        actorUserId: adminAId,
        actorName: "Admin Alpha",
        entity: "pending_storage_deletion",
        entityId: 9101,
        action: "force_retry",
        metadata: { path: "/objects/tie-A" },
        createdAt: sharedTs,
      }).returning({ id: memberAuditLogTable.id });
      auditIds.push(tieA.id);
      const [tieB] = await db.insert(memberAuditLogTable).values({
        organizationId: orgAId,
        clubMemberId: liveMemberId,
        actorUserId: adminAId,
        actorName: "Admin Alpha",
        entity: "pending_storage_deletion",
        entityId: 9102,
        action: "resolve",
        metadata: { path: "/objects/tie-B" },
        createdAt: sharedTs,
      }).returning({ id: memberAuditLogTable.id });
      auditIds.push(tieB.id);

      // Six valid rows now (a1-a4 plus tieA/tieB). Walk the whole list
      // with limit=1.
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const url = cursor
          ? URL(`?limit=1&cursor=${encodeURIComponent(cursor)}`)
          : URL("?limit=1");
        // eslint-disable-next-line no-await-in-loop
        const r = await request(app).get(url);
        expect(r.status).toBe(200);
        if (r.body.items.length === 0) break;
        for (const it of r.body.items) {
          // No row may appear twice across pages.
          expect(seen).not.toContain(it.id);
          seen.push(it.id);
        }
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      // We must have seen all six valid orgA rows and nothing leaked
      // from the noise / cross-org fixtures.
      expect(seen).toEqual(expect.arrayContaining([
        auditIds[0], auditIds[1], auditIds[2], auditIds[3], tieA.id, tieB.id,
      ]));
      // Of the two tied-createdAt rows, the one with the larger id comes
      // first under (createdAt DESC, id DESC) — this is the property the
      // composite cursor exists to preserve.
      const tieAPos = seen.indexOf(tieA.id);
      const tieBPos = seen.indexOf(tieB.id);
      // tieB was inserted second → larger id → must appear before tieA.
      expect(tieBPos).toBeLessThan(tieAPos);
      // And the two tied rows must be adjacent in the walk.
      expect(Math.abs(tieAPos - tieBPos)).toBe(1);
    });

    it("preserves microsecond precision in the cursor so rows sharing a millisecond are never skipped", async () => {
      const app = createTestApp(adminAUser());

      // Three rows landing in the same JS-millisecond window but at
      // different *microseconds* — exactly the shape the DB default
      // `now()` produces under load. JS Date is millisecond-precise, so
      // a cursor that round-trips through `new Date(...).toISOString()`
      // would truncate the µs tail and silently drop the in-between
      // rows. We bypass drizzle's Date binding and write the timestamps
      // verbatim to keep the µs intact.
      const baseMs = "2026-04-21T07:08:09";
      const rows: { id: number }[] = [];
      for (const us of ["123456", "123789", "123999"]) {
        // eslint-disable-next-line no-await-in-loop
        const inserted = await db.execute(sql`
          INSERT INTO member_audit_log
            (organization_id, club_member_id, actor_user_id, actor_name,
             entity, entity_id, action, metadata, created_at)
          VALUES
            (${orgAId}, ${liveMemberId}, ${adminAId}, 'Admin Alpha',
             'pending_storage_deletion', ${9200 + parseInt(us, 10)},
             'force_retry',
             ${JSON.stringify({ path: `/objects/us-${us}` })}::jsonb,
             ${`${baseMs}.${us}Z`}::timestamptz)
          RETURNING id
        `);
        const r = (inserted.rows ?? inserted) as { id: number }[];
        rows.push(r[0]);
        auditIds.push(r[0].id);
      }
      const usIds = rows.map(r => r.id);

      // Page through with limit=1 and assert *every* µs-row is reachable
      // by the cursor — not just the first.
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const url = cursor
          ? URL(`?limit=1&cursor=${encodeURIComponent(cursor)}`)
          : URL("?limit=1");
        // eslint-disable-next-line no-await-in-loop
        const r = await request(app).get(url);
        expect(r.status).toBe(200);
        if (r.body.items.length === 0) break;
        for (const it of r.body.items) seen.push(it.id);
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      // All three µs-rows must show up; if the cursor silently truncated
      // to ms, the older two would be skipped after the first one.
      for (const id of usIds) {
        expect(seen).toContain(id);
      }
    });

    it("respects active filters when paging — cursor never re-introduces filtered-out rows", async () => {
      const app = createTestApp(adminAUser());

      // Filter to action=resolve. Only a2 (resolve, 04-24) qualifies among
      // the original three. Page-of-1 must return it then exhaust.
      const p1 = await request(app)
        .get(URL("?limit=1&action=resolve"));
      expect(p1.status).toBe(200);
      expect(p1.body.items.length).toBeGreaterThanOrEqual(1);
      // a2 is the newest resolve row in orgA's original fixtures.
      const firstId = p1.body.items[0].id as number;
      expect([auditIds[1] /* a2 */]).toContain(firstId);

      if (p1.body.nextCursor) {
        const p2 = await request(app).get(
          URL(`?limit=1&action=resolve&cursor=${encodeURIComponent(p1.body.nextCursor)}`),
        );
        expect(p2.status).toBe(200);
        // No force_retry row may appear under action=resolve, even on page 2.
        for (const it of p2.body.items) {
          expect(it.action).toBe("resolve");
          expect(it.id).not.toBe(auditIds[0]); // a1 is force_retry
          expect(it.id).not.toBe(auditIds[2]); // a3 is force_retry
        }
      }
    });
  });
});
