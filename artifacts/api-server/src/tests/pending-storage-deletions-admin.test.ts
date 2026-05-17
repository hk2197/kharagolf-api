/**
 * Integration tests: Task #1128 — admin actions on stuck pending_storage_deletions rows.
 *
 *   1. GET /erasures/storage-failures/pending lists rows with member info,
 *      attempts, last error, last + next attempt timestamps, and an
 *      `exhausted` flag derived from the same threshold the org-wide
 *      counter uses.
 *   2. ?onlyExhausted=true (the default) hides rows below the threshold;
 *      ?onlyExhausted=false returns them too.
 *   3. POST /pending/:id/retry-now resets nextAttemptAt to ~now without
 *      touching attempts, and writes an audit-trail row with action
 *      "force_retry".
 *   4. POST /pending/:id/resolve requires a reason, deletes the queue row,
 *      and writes an audit row capturing path, attempts, and last error.
 *   5. Cross-org access is blocked (404, not 403, so we don't leak
 *      existence) and non-admin callers are blocked with 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
  pendingStorageDeletionsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
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
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pending_storage_deletions (
      id serial PRIMARY KEY,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      club_member_id integer,
      source_audit_id integer,
      path text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamptz,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Task #1303 — exhaustion_notified_at was added by Task #1127 (migration 0096);
  // older test DBs may not have it, so make sure it's present before the
  // GET endpoint tries to SELECT it.
  await db.execute(sql`
    ALTER TABLE pending_storage_deletions
      ADD COLUMN IF NOT EXISTS exhaustion_notified_at timestamptz
  `);
}

let testOrgId: number;
let otherOrgId: number;
let memberId: number;
let exhaustedRowId: number;
let freshRowId: number;
let otherOrgRowId: number;
let adminUserId: number;
let nonAdminUserId: number;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PendingStorage_${ts}`,
    slug: `test-pending-storage-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [org2] = await db.insert(organizationsTable).values({
    name: `TestOrg_PendingStorage_Other_${ts}`,
    slug: `test-pending-storage-other-${ts}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = org2.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId, firstName: "Stuck", lastName: "Member",
    email: `stuck-${ts}@example.test`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `psd-admin-${ts}`, username: `psd_admin_${ts}`,
    role: "org_admin", organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId, userId: adminUserId, role: "org_admin",
  });

  const [nonAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `psd-player-${ts}`, username: `psd_player_${ts}`, role: "player",
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminRow.id;

  const admin: TestUser = { id: adminUserId, username: `psd_admin_${ts}`, role: "org_admin", organizationId: testOrgId };
  const nonAdmin: TestUser = { id: nonAdminUserId, username: `psd_player_${ts}`, role: "player" };
  app = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);

  // Exhausted row: 12 attempts, 24h-out next-attempt, real last-error string.
  // Task #1303 — also seed `exhaustionNotifiedAt` so the GET endpoint test
  // can verify the field is surfaced for rows admins were already paged on.
  const [exhausted] = await db.insert(pendingStorageDeletionsTable).values({
    organizationId: testOrgId,
    clubMemberId: memberId,
    path: "/objects/abc-exhausted",
    attempts: 12,
    lastAttemptAt: new Date(Date.now() - 60_000),
    lastError: "TimeoutError: backend unavailable",
    nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    exhaustionNotifiedAt: new Date(Date.now() - 30 * 60 * 1000),
  }).returning({ id: pendingStorageDeletionsTable.id });
  exhaustedRowId = exhausted.id;

  // Fresh row: 1 attempt — must be hidden by default but visible with
  // ?onlyExhausted=false.
  const [fresh] = await db.insert(pendingStorageDeletionsTable).values({
    organizationId: testOrgId,
    clubMemberId: memberId,
    path: "/objects/abc-fresh",
    attempts: 1,
    nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
  }).returning({ id: pendingStorageDeletionsTable.id });
  freshRowId = fresh.id;

  // Row in another org — must never appear in this org's list and must
  // 404 on cross-org mutations.
  const [other] = await db.insert(pendingStorageDeletionsTable).values({
    organizationId: otherOrgId,
    clubMemberId: null,
    path: "/objects/other-org",
    attempts: 99,
  }).returning({ id: pendingStorageDeletionsTable.id });
  otherOrgRowId = other.id;
});

afterAll(async () => {
  await db.delete(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
  await db.delete(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.organizationId, otherOrgId));
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

const baseUrl = () => `/api/organizations/${testOrgId}/members-360`;

describe("GET /erasures/storage-failures/pending", () => {
  it("lists exhausted rows with full detail by default and excludes other orgs", async () => {
    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures/pending`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.onlyExhausted).toBe(true);
    expect(res.body.count).toBe(1);
    const it0 = res.body.items[0];
    expect(it0.id).toBe(exhaustedRowId);
    expect(it0.path).toBe("/objects/abc-exhausted");
    expect(it0.attempts).toBe(12);
    expect(it0.exhausted).toBe(true);
    expect(it0.lastError).toMatch(/Timeout/);
    expect(it0.memberFirstName).toBe("Stuck");
    expect(it0.memberDeleted).toBe(false);
    // Task #1303 — already-alerted rows must surface the timestamp so the
    // dashboard can render the "Alerted at <date>" pill and avoid duplicate
    // on-call escalations.
    expect(typeof it0.exhaustionNotifiedAt).toBe("string");
    expect(Number.isNaN(Date.parse(it0.exhaustionNotifiedAt))).toBe(false);
    // Cross-org rows must never appear.
    expect(res.body.items.find((x: { id: number }) => x.id === otherOrgRowId)).toBeUndefined();
    // Fresh (non-exhausted) rows must be hidden by the default filter.
    expect(res.body.items.find((x: { id: number }) => x.id === freshRowId)).toBeUndefined();
  });

  it("includes non-exhausted rows when onlyExhausted=false", async () => {
    const res = await request(app).get(`${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.onlyExhausted).toBe(false);
    expect(res.body.count).toBe(2);
    const fresh = res.body.items.find((x: { id: number }) => x.id === freshRowId);
    expect(fresh).toBeTruthy();
    expect(fresh.exhausted).toBe(false);
    expect(fresh.attempts).toBe(1);
    // Task #1303 — a row that has not crossed the exhaustion threshold
    // hasn't been alerted on, so the field should be null (not omitted).
    expect(fresh.exhaustionNotifiedAt).toBeNull();
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).get(`${baseUrl()}/erasures/storage-failures/pending`);
    expect(res.status).toBe(403);
  });

  // Task #1537 — admins running a bucket-migration sweep should be able
  // to narrow the visible cohort by path prefix or by lastError substring
  // *before* pressing the bulk action, so the filters are applied
  // server-side and the response echoes the sanitized inputs back.
  describe("filters (Task #1537)", () => {
    it("narrows the list to rows whose path starts with the given prefix", async () => {
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&pathPrefix=${encodeURIComponent("/objects/abc-fresh")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.pathPrefix).toBe("/objects/abc-fresh");
      expect(res.body.count).toBe(1);
      expect(res.body.items[0].id).toBe(freshRowId);
    });

    it("returns nothing when the prefix doesn't match anything", async () => {
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&pathPrefix=${encodeURIComponent("/objects/does-not-exist/")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    it("trims whitespace and ignores blank filters", async () => {
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&pathPrefix=${encodeURIComponent("   ")}&errorContains=${encodeURIComponent("")}`,
      );
      expect(res.status, res.text).toBe(200);
      // Blank-after-trim filters must NOT narrow the list — same surface
      // as omitting them entirely.
      expect(res.body.pathPrefix).toBe("");
      expect(res.body.errorContains).toBe("");
      expect(res.body.count).toBe(2);
    });

    it("escapes LIKE wildcards in the path prefix so a literal % does not widen the match", async () => {
      // No row has a literal "%" in its path, so the request should
      // legitimately return zero rows — proving "%" is treated as a
      // literal character and not as a wildcard.
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&pathPrefix=${encodeURIComponent("%")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.count).toBe(0);
    });

    it("narrows the list to rows whose lastError contains the substring (case-insensitive)", async () => {
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?errorContains=${encodeURIComponent("timeout")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.errorContains).toBe("timeout");
      expect(res.body.count).toBe(1);
      expect(res.body.items[0].id).toBe(exhaustedRowId);
    });

    it("excludes rows with a null lastError when errorContains is set", async () => {
      // The fresh row has lastError = null, so even with onlyExhausted=false
      // it must NOT appear when errorContains is non-empty.
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&errorContains=${encodeURIComponent("timeout")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.items.find((x: { id: number }) => x.id === freshRowId)).toBeUndefined();
    });

    it("combines pathPrefix and errorContains with AND semantics", async () => {
      // Prefix matches the exhausted row but errorContains does not — the
      // intersection must be empty (not the union).
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?pathPrefix=${encodeURIComponent("/objects/abc-exhausted")}&errorContains=${encodeURIComponent("nonsense-string-no-row-has")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.count).toBe(0);
    });

    it("still excludes other-org rows even with a matching prefix", async () => {
      const res = await request(app).get(
        `${baseUrl()}/erasures/storage-failures/pending?onlyExhausted=false&pathPrefix=${encodeURIComponent("/objects/other-org")}`,
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.items.find((x: { id: number }) => x.id === otherOrgRowId)).toBeUndefined();
    });
  });
});

describe("POST /erasures/storage-failures/pending/:pendingId/retry-now", () => {
  it("resets nextAttemptAt to ~now without changing attempts and writes a force_retry audit row", async () => {
    const before = await db.select({
      attempts: pendingStorageDeletionsTable.attempts,
      nextAttemptAt: pendingStorageDeletionsTable.nextAttemptAt,
    }).from(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.id, exhaustedRowId));
    expect(before[0].attempts).toBe(12);

    const t0 = Date.now();
    const res = await request(app).post(`${baseUrl()}/erasures/storage-failures/pending/${exhaustedRowId}/retry-now`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(exhaustedRowId);
    expect(res.body.attempts).toBe(12);
    const newNext = new Date(res.body.nextAttemptAt).getTime();
    // Within a generous window of "now" — the worker should pick it up
    // on its next tick rather than waiting for the original 24h backoff.
    expect(newNext).toBeGreaterThanOrEqual(t0 - 5_000);
    expect(newNext).toBeLessThanOrEqual(Date.now() + 5_000);

    // Force-retry audit row must exist with action force_retry and capture
    // the path so a later investigator can reconstruct the chain.
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "pending_storage_deletion"),
        eq(memberAuditLogTable.entityId, exhaustedRowId),
        eq(memberAuditLogTable.action, "force_retry"),
      ));
    expect(audit).toBeTruthy();
    expect(audit.actorUserId).toBe(adminUserId);
    const md = (audit.metadata ?? {}) as Record<string, unknown>;
    expect(md.path).toBe("/objects/abc-exhausted");
    expect(md.attempts).toBe(12);
  });

  it("404s on a row that belongs to a different org (no existence leak)", async () => {
    const res = await request(app).post(`${baseUrl()}/erasures/storage-failures/pending/${otherOrgRowId}/retry-now`);
    expect(res.status).toBe(404);
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).post(`${baseUrl()}/erasures/storage-failures/pending/${exhaustedRowId}/retry-now`);
    expect(res.status).toBe(403);
  });
});

describe("POST /erasures/storage-failures/pending/:pendingId/resolve", () => {
  it("requires a reason", async () => {
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/${freshRowId}/resolve`)
      .send({ reason: "   " });
    expect(res.status).toBe(400);
    // Row must still exist after a rejected resolve.
    const [row] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, freshRowId));
    expect(row).toBeTruthy();
  });

  it("deletes the row and writes an audit row capturing path / attempts / last error", async () => {
    // Use the fresh row so we don't disturb the one already used by the
    // retry-now test above.
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/${freshRowId}/resolve`)
      .send({ reason: "confirmed deleted via bucket migration" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.resolved).toBe(true);

    const remaining = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, freshRowId));
    expect(remaining.length).toBe(0);

    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "pending_storage_deletion"),
        eq(memberAuditLogTable.entityId, freshRowId),
        eq(memberAuditLogTable.action, "resolve"),
      ));
    expect(audit).toBeTruthy();
    expect(audit.reason).toMatch(/bucket migration/);
    expect(audit.actorUserId).toBe(adminUserId);
    const md = (audit.metadata ?? {}) as Record<string, unknown>;
    expect(md.path).toBe("/objects/abc-fresh");
    expect(md.attempts).toBe(1);
  });

  it("404s on a row that belongs to a different org (no existence leak)", async () => {
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/${otherOrgRowId}/resolve`)
      .send({ reason: "should not work" });
    expect(res.status).toBe(404);
    // The cross-org row must still exist.
    const [row] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, otherOrgRowId));
    expect(row).toBeTruthy();
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp)
      .post(`${baseUrl()}/erasures/storage-failures/pending/${exhaustedRowId}/resolve`)
      .send({ reason: "nope" });
    expect(res.status).toBe(403);
  });
});

// ─── Task #1302 — bulk admin actions ──────────────────────────────────────────
//
// Each test seeds fresh rows so the order is independent of the single-row
// suites above. The bulk endpoints must (a) write one audit row per id so
// the per-row trail is preserved, (b) atomically reject the whole request
// with 404 when any id is unknown or cross-org (no partial application,
// no existence leak), and (c) require auth + reason consistent with the
// single-row resolve endpoint.

async function seedBulkRow(opts: { orgId?: number; attempts?: number; path?: string } = {}) {
  const [row] = await db.insert(pendingStorageDeletionsTable).values({
    organizationId: opts.orgId ?? testOrgId,
    clubMemberId: opts.orgId && opts.orgId !== testOrgId ? null : memberId,
    path: opts.path ?? `/objects/bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    attempts: opts.attempts ?? 12,
    lastAttemptAt: new Date(Date.now() - 60_000),
    lastError: "TimeoutError: backend unavailable",
    nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: pendingStorageDeletionsTable.id });
  return row.id;
}

describe("POST /erasures/storage-failures/pending/bulk-retry-now", () => {
  it("rejects an empty ids array with 400", async () => {
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-retry-now`)
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it("resets nextAttemptAt for every row and writes one force_retry audit per id", async () => {
    const idA = await seedBulkRow({ path: "/objects/bulk-retry-a" });
    const idB = await seedBulkRow({ path: "/objects/bulk-retry-b" });
    const t0 = Date.now();
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-retry-now`)
      .send({ ids: [idA, idB], reason: "post-migration sweep" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.count).toBe(2);
    expect(new Set(res.body.ids)).toEqual(new Set([idA, idB]));

    const updated = await db.select().from(pendingStorageDeletionsTable)
      .where(sql`${pendingStorageDeletionsTable.id} IN (${idA}, ${idB})`);
    for (const u of updated) {
      const next = (u.nextAttemptAt ?? new Date(0)).getTime();
      expect(next).toBeGreaterThanOrEqual(t0 - 5_000);
      expect(next).toBeLessThanOrEqual(Date.now() + 5_000);
      // attempts must be untouched so genuinely-stuck rows stay exhausted.
      expect(u.attempts).toBe(12);
    }

    // One audit row per id with action force_retry, the shared reason,
    // and metadata.bulk=true so investigators can tell the bulk action
    // apart from the per-row force-retry endpoint.
    for (const id of [idA, idB]) {
      const [audit] = await db.select().from(memberAuditLogTable)
        .where(and(
          eq(memberAuditLogTable.organizationId, testOrgId),
          eq(memberAuditLogTable.entity, "pending_storage_deletion"),
          eq(memberAuditLogTable.entityId, id),
          eq(memberAuditLogTable.action, "force_retry"),
        ));
      expect(audit, `audit row for id ${id}`).toBeTruthy();
      expect(audit.actorUserId).toBe(adminUserId);
      expect(audit.reason).toBe("post-migration sweep");
      const md = (audit.metadata ?? {}) as Record<string, unknown>;
      expect(md.bulk).toBe(true);
      expect(typeof md.path).toBe("string");
    }
  });

  it("404s and applies nothing when any id is cross-org (no existence leak, no partial apply)", async () => {
    const ourId = await seedBulkRow({ path: "/objects/bulk-retry-our" });
    const before = await db.select({
      next: pendingStorageDeletionsTable.nextAttemptAt,
    }).from(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.id, ourId));
    const beforeNext = (before[0].next ?? new Date(0)).getTime();

    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-retry-now`)
      .send({ ids: [ourId, otherOrgRowId] });
    expect(res.status).toBe(404);

    // Our row must not have been updated — partial application would
    // be a silent surprise for an admin expecting all-or-nothing.
    const after = await db.select({
      next: pendingStorageDeletionsTable.nextAttemptAt,
    }).from(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.id, ourId));
    expect((after[0].next ?? new Date(0)).getTime()).toBe(beforeNext);

    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "pending_storage_deletion"),
        eq(memberAuditLogTable.entityId, ourId),
        eq(memberAuditLogTable.action, "force_retry"),
      ));
    expect(audits.length).toBe(0);
  });

  it("rejects non-admin callers with 403", async () => {
    const id = await seedBulkRow({ path: "/objects/bulk-retry-403" });
    const res = await request(nonAdminApp)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-retry-now`)
      .send({ ids: [id] });
    expect(res.status).toBe(403);
  });
});

describe("POST /erasures/storage-failures/pending/bulk-resolve", () => {
  it("requires a non-empty reason and a non-empty ids array", async () => {
    const id = await seedBulkRow({ path: "/objects/bulk-resolve-need-reason" });
    const res1 = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-resolve`)
      .send({ ids: [id], reason: "   " });
    expect(res1.status).toBe(400);
    const [stillThere] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, id));
    expect(stillThere).toBeTruthy();

    const res2 = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-resolve`)
      .send({ ids: [], reason: "anything" });
    expect(res2.status).toBe(400);
  });

  it("deletes every row and writes one resolve audit row per id with the shared reason", async () => {
    const idA = await seedBulkRow({ path: "/objects/bulk-resolve-a" });
    const idB = await seedBulkRow({ path: "/objects/bulk-resolve-b" });
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-resolve`)
      .send({ ids: [idA, idB], reason: "confirmed deleted via bucket migration on 2026-04-20" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.resolved).toBe(true);
    expect(new Set(res.body.ids)).toEqual(new Set([idA, idB]));

    const remaining = await db.select().from(pendingStorageDeletionsTable)
      .where(sql`${pendingStorageDeletionsTable.id} IN (${idA}, ${idB})`);
    expect(remaining.length).toBe(0);

    for (const id of [idA, idB]) {
      const [audit] = await db.select().from(memberAuditLogTable)
        .where(and(
          eq(memberAuditLogTable.organizationId, testOrgId),
          eq(memberAuditLogTable.entity, "pending_storage_deletion"),
          eq(memberAuditLogTable.entityId, id),
          eq(memberAuditLogTable.action, "resolve"),
        ));
      expect(audit, `audit row for id ${id}`).toBeTruthy();
      expect(audit.actorUserId).toBe(adminUserId);
      expect(audit.reason).toMatch(/bucket migration/);
      const md = (audit.metadata ?? {}) as Record<string, unknown>;
      expect(md.bulk).toBe(true);
      expect(typeof md.path).toBe("string");
      // Last error + path must be captured before the row is gone so the
      // chain can be reconstructed later.
      expect(md.lastError).toBeTruthy();
    }
  });

  it("404s and deletes nothing when any id is cross-org (no existence leak, no partial apply)", async () => {
    const ourId = await seedBulkRow({ path: "/objects/bulk-resolve-our" });
    const res = await request(app)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-resolve`)
      .send({ ids: [ourId, otherOrgRowId], reason: "should not work" });
    expect(res.status).toBe(404);

    // Our row must still exist — partial deletion of a known-good row
    // when the cross-org leak was the actual problem would be data loss.
    const [stillThere] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, ourId));
    expect(stillThere).toBeTruthy();

    // The cross-org row must also still exist (caller had no permission
    // to delete it in the first place).
    const [otherStill] = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.id, otherOrgRowId));
    expect(otherStill).toBeTruthy();

    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "pending_storage_deletion"),
        eq(memberAuditLogTable.entityId, ourId),
        eq(memberAuditLogTable.action, "resolve"),
      ));
    expect(audits.length).toBe(0);
  });

  it("rejects non-admin callers with 403", async () => {
    const id = await seedBulkRow({ path: "/objects/bulk-resolve-403" });
    const res = await request(nonAdminApp)
      .post(`${baseUrl()}/erasures/storage-failures/pending/bulk-resolve`)
      .send({ ids: [id], reason: "nope" });
    expect(res.status).toBe(403);
  });
});
