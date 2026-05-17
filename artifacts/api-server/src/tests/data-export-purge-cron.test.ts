/**
 * Integration tests: Expired data-export archive purger (Task #619).
 *
 * Members can request a tracked archive of their data; once `resolvedAt + 7
 * days` has elapsed, the underlying JSON file in private object storage is
 * deleted and `artifactUrl` is cleared so the row reads as `expired`.
 *
 * The real GCS sidecar isn't available in tests, so we inject a fake storage
 * adapter that records which artifacts were asked to be deleted.
 */
// ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
// The api-server vitest suite runs in a single fork against a shared
// dev DB and `purgeExpiredDataExportArchives` sweeps
// `member_data_requests` globally. Unscoped `result.purged/.failed/
// .missing` counters would flake the moment a sibling cron test leaks a
// matching expired row, so this file scopes assertions via DB queries
// filtered by `testOrgId` (e.g. count of OUR rows with purged_at NOT NULL).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, sql, isNotNull } from "drizzle-orm";
import { purgeExpiredDataExportArchives } from "../lib/cron.js";
import { ObjectNotFoundError } from "../lib/objectStorage.js";

// Row-scoped counters — only count rows owned by THIS test's org.
async function ourPurgedCount() {
  const rows = await db.select().from(memberDataRequestsTable).where(and(
    eq(memberDataRequestsTable.organizationId, testOrgId),
    isNotNull(memberDataRequestsTable.purgedAt),
  ));
  return rows.length;
}
async function ourArtifactStillSet() {
  const rows = await db.select().from(memberDataRequestsTable).where(and(
    eq(memberDataRequestsTable.organizationId, testOrgId),
    isNotNull(memberDataRequestsTable.artifactUrl),
  ));
  return rows.length;
}

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text, body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz, error_message text,
      related_entity text, related_entity_id integer
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz, resolved_at timestamptz, notes text, artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL
    )`);
  // Task #773: cron now stamps purged_at when an expired archive is removed.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS purged_at timestamptz`);
  // Audit table for the cron-source purge audit row.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text, actor_role text,
      entity text NOT NULL, entity_id integer,
      action text NOT NULL,
      field_changes jsonb, reason text, metadata jsonb,
      ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

let testOrgId: number;
let testMemberId: number;
let testUserId: number;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PurgeExports_${ts}`,
    slug: `test-purge-exports-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `purge-exports-${ts}`,
    username: `purge_exports_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Purge",
    lastName: "Tester",
    email: `purge-exports-${ts}@example.test`,
    userId: testUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
});

type PurgeStorage = NonNullable<NonNullable<Parameters<typeof purgeExpiredDataExportArchives>[0]>["storage"]>;
type PurgeStorageFile = Awaited<ReturnType<PurgeStorage["getObjectEntityFile"]>>;

function makeStorage(opts?: { missingPaths?: Set<string>; failPaths?: Set<string> }): PurgeStorage & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async getObjectEntityFile(path: string): Promise<PurgeStorageFile> {
      if (opts?.missingPaths?.has(path)) throw new ObjectNotFoundError();
      if (opts?.failPaths?.has(path)) throw new Error("simulated storage outage");
      return {
        async delete() { deleted.push(path); },
      } as unknown as PurgeStorageFile;
    },
  };
}

describe("purgeExpiredDataExportArchives", () => {
  it("deletes the stored object and clears artifactUrl for archives older than 7 days", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: eightDaysAgo,
      artifactUrl: "/objects/data-exports/1/1.json",
    }).returning();

    const storage = makeStorage();
    await purgeExpiredDataExportArchives({ storage });
    expect(await ourPurgedCount()).toBe(1);
    expect(storage.deleted).toContain("/objects/data-exports/1/1.json");

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.artifactUrl).toBeNull();
    expect(after.status).toBe("completed");
    expect(after.resolvedAt).not.toBeNull();
    // Task #773: cron now stamps when the archive was actually purged so the
    // member portal and controller dashboard can show "Removed on <date>".
    expect(after.purgedAt).not.toBeNull();

    // Task #773: a member-audit row tagged metadata.source = "cron" is written
    // for every successful purge so the data-minimisation guarantee is
    // visible end-to-end (member 360 audit timeline + admin dashboard).
    const auditRows = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_export"),
        eq(memberAuditLogTable.entityId, row.id),
      ));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe("purge");
    expect(auditRows[0].clubMemberId).toBe(testMemberId);
    expect(auditRows[0].actorName).toBe("system");
    expect(auditRows[0].metadata).toMatchObject({
      source: "cron",
      artifactUrl: "/objects/data-exports/1/1.json",
      alreadyMissing: false,
    });
  });

  it("leaves still-fresh archives (within the 7-day window) completely untouched", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: twoDaysAgo,
      artifactUrl: "/objects/data-exports/1/2.json",
    }).returning();

    const storage = makeStorage();
    await purgeExpiredDataExportArchives({ storage });
    expect(await ourPurgedCount()).toBe(0);
    expect(storage.deleted).toEqual([]);

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.artifactUrl).toBe("/objects/data-exports/1/2.json");
  });

  it("ignores rows that already have a null artifactUrl (nothing to clean)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: eightDaysAgo,
      artifactUrl: null,
    });

    const storage = makeStorage();
    await purgeExpiredDataExportArchives({ storage });
    expect(await ourPurgedCount()).toBe(0);
    expect(storage.deleted).toEqual([]);
  });

  it("treats already-missing objects as purged so the row still gets cleaned up", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: eightDaysAgo,
      artifactUrl: "/objects/data-exports/missing.json",
    }).returning();

    const storage = makeStorage({ missingPaths: new Set(["/objects/data-exports/missing.json"]) });
    await purgeExpiredDataExportArchives({ storage });
    // Our row was purged — even though the object was missing.
    expect(await ourPurgedCount()).toBe(1);

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.artifactUrl).toBeNull();
    // Audit row marks it as alreadyMissing so the missing-vs-purged
    // distinction stays observable per-row even without `result.missing`.
    const [audit] = await db.select().from(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.organizationId, testOrgId),
      eq(memberAuditLogTable.entityId, row.id),
    ));
    expect(audit?.metadata).toMatchObject({ alreadyMissing: true });
  });

  it("keeps artifactUrl intact when the storage delete fails so the next pass can retry", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: eightDaysAgo,
      artifactUrl: "/objects/data-exports/flaky.json",
    }).returning();

    const storage = makeStorage({ failPaths: new Set(["/objects/data-exports/flaky.json"]) });
    await purgeExpiredDataExportArchives({ storage });
    // Failed delete leaves our row un-purged AND artifactUrl intact for retry.
    expect(await ourPurgedCount()).toBe(0);
    expect(await ourArtifactStillSet()).toBe(1);

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.artifactUrl).toBe("/objects/data-exports/flaky.json");
  });

  it("only touches access exports — erasure rows with an artifactUrl are ignored", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "erasure",
      status: "completed",
      resolvedAt: eightDaysAgo,
      artifactUrl: "/objects/erasure-receipt.json",
    }).returning();

    const storage = makeStorage();
    await purgeExpiredDataExportArchives({ storage });
    expect(await ourPurgedCount()).toBe(0);
    expect(storage.deleted).toEqual([]);

    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(after.artifactUrl).toBe("/objects/erasure-receipt.json");
  });
});
