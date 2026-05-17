/**
 * Integration tests: pre-flight preview for the bulk-action reverse dialog
 * (Task #259 / #295).
 *
 * Covers POST /api/organizations/:orgId/members-360/bulk-action/reverse/preview
 * for the three reversible action families that ship today:
 *   - lifecycle freeze (reason: "bulk freeze", entity: lifecycle)
 *   - tag add        (reason: "bulk tag: <name>", entity: tag)
 *   - tier_change    (reason: "bulk tier_change → <id>", entity: tier)
 *
 * For each bucket the test:
 *   1. seeds the bulk action via POST /bulk-action so the audit/lifecycle/ext
 *      rows are written exactly the way production writes them,
 *   2. reads the bucket timestamp by truncating the audit row's createdAt to
 *      the minute (matches the date_trunc('minute', …) the buckets endpoint
 *      uses), and
 *   3. mutates a few members back to the original (pre-bulk) state so the
 *      preview should classify them as `alreadyReversed` no-ops.
 *
 * Assertions then pin the willChange / alreadyReversed / affectedMembers
 * counts the dialog renders. A fourth scenario removes one member from the
 * org entirely so we also exercise the "cohort changed" path where
 * affectedMembers shrinks below the original cohort size.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  membershipTiersTable,
  memberProfileExtTable,
  memberLifecycleEventsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testUserId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let originalTierId: number;
let restoreTierId: number;
let memberIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

/** Truncate a Date down to the start of its minute — mirrors the bucket math
 * the buckets endpoint exposes via `date_trunc('minute', createdAt)`. */
function bucketIsoOf(d: Date): string {
  const t = new Date(d);
  t.setSeconds(0, 0);
  return t.toISOString();
}

/** Pull the most-recent audit row matching (entity, reason) so we can read its
 * createdAt and derive the bucket the UI would have shown. */
async function latestBucketFor(entity: string, reason: string): Promise<string> {
  const [row] = await db.select({ createdAt: memberAuditLogTable.createdAt })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, testOrgId),
      eq(memberAuditLogTable.entity, entity),
      eq(memberAuditLogTable.reason, reason),
    ))
    .orderBy(sql`${memberAuditLogTable.createdAt} desc`)
    .limit(1);
  expect(row, `No audit row found for entity=${entity} reason=${reason}`).toBeDefined();
  return bucketIsoOf(row!.createdAt as Date);
}

async function callPreview(body: Record<string, unknown>) {
  return request(app).post(`${BASE()}/bulk-action/reverse/preview`).send(body);
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkRevPrev_${stamp}`,
    slug: `test-bulk-rev-prev-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-rev-prev-${stamp}`,
    username: `test_bulk_rev_admin_${stamp}`,
    email: `bulk_rev_admin_${stamp}@example.com`,
    displayName: "Bulk Reverse Preview Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  // Two tiers in this org so the tier_change bucket has somewhere to come from
  // and somewhere to go. Insert via raw SQL so the test only writes the
  // columns it needs (the ORM model declares defaults for some columns that
  // may not yet exist in this database snapshot).
  const origRows = await db.execute(sql`
    INSERT INTO membership_tiers (organization_id, name, annual_fee)
    VALUES (${testOrgId}, ${`Original_${stamp}`}, ${"1000"})
    RETURNING id
  `);
  originalTierId = (origRows as unknown as { rows: Array<{ id: number }> }).rows[0].id;

  const restRows = await db.execute(sql`
    INSERT INTO membership_tiers (organization_id, name, annual_fee)
    VALUES (${testOrgId}, ${`Restore_${stamp}`}, ${"2000"})
    RETURNING id
  `);
  restoreTierId = (restRows as unknown as { rows: Array<{ id: number }> }).rows[0].id;

  // Seed five members per bucket — enough cohort to assert non-trivial counts.
  const members = await db.insert(clubMembersTable).values(
    Array.from({ length: 5 }, (_, i) => ({
      organizationId: testOrgId,
      tierId: originalTierId,
      firstName: `BulkRev${i}`,
      lastName: `Tester_${stamp}`,
      email: `bulk_rev_${i}_${stamp}@example.com`,
    })),
  ).returning({ id: clubMembersTable.id });
  memberIds = members.map(m => m.id);

  admin = {
    id: testUserId,
    username: `test_bulk_rev_admin_${stamp}`,
    displayName: "Bulk Reverse Preview Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (memberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, memberIds));
  }
  if (originalTierId || restoreTierId) {
    await db.delete(membershipTiersTable)
      .where(eq(membershipTiersTable.organizationId, testOrgId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

describe("POST /bulk-action/reverse/preview — freeze bucket", () => {
  let bucket: string;
  const reason = "bulk freeze";

  beforeAll(async () => {
    const r = await request(app).post(`${BASE()}/bulk-action`).send({
      memberIds, action: "freeze",
    });
    expect(r.status, r.text).toBe(200);
    bucket = await latestBucketFor("lifecycle", reason);

    // Manually unfreeze 2 of the 5 — those are now back to "active" so the
    // preview should count them as alreadyReversed no-ops.
    const exts = await db.select({
      id: memberProfileExtTable.id,
      clubMemberId: memberProfileExtTable.clubMemberId,
    }).from(memberProfileExtTable)
      .where(inArray(memberProfileExtTable.clubMemberId, memberIds.slice(0, 2)));
    for (const e of exts) {
      await db.update(memberProfileExtTable)
        .set({ lifecycleStatus: "active", updatedAt: new Date() })
        .where(eq(memberProfileExtTable.id, e.id));
    }
  });

  it("counts willChange / alreadyReversed against the seeded freeze bucket", async () => {
    const res = await callPreview({
      bucket, entity: "lifecycle", reason, actorUserId: testUserId,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("freeze");
    expect(res.body.affectedMembers).toBe(5);
    // 3 still frozen → 3 will change; 2 manually unfrozen → already reversed.
    expect(res.body.willChange).toBe(3);
    expect(res.body.alreadyReversed).toBe(2);
  });

  it("reflects a shrunk cohort when an affected member leaves the org", async () => {
    // Detach one member from the org. The reverse handler re-validates
    // tenancy, so affectedMembers should drop from 5 to 4.
    const dropped = memberIds[4];
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, dropped));

    const res = await callPreview({
      bucket, entity: "lifecycle", reason, actorUserId: testUserId,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.affectedMembers).toBe(4);
    // The dropped member was one of the 3 still-frozen → willChange now 2.
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyReversed).toBe(2);

    // Re-insert so the rest of the suite still has its full cohort.
    const [restored] = await db.insert(clubMembersTable).values({
      id: dropped,
      organizationId: testOrgId,
      tierId: originalTierId,
      firstName: "BulkRev4",
      lastName: "Tester_restored",
      email: `bulk_rev_4_restored_${Date.now()}@example.com`,
    }).returning({ id: clubMembersTable.id });
    memberIds[4] = restored.id;
  });
});

describe("POST /bulk-action/reverse/preview — tag bucket", () => {
  const tag = "preview-test-tag";
  const reason = `bulk tag: ${tag}`;
  let bucket: string;

  beforeAll(async () => {
    // Use a fresh subset of 4 members so this bucket is independent.
    const r = await request(app).post(`${BASE()}/bulk-action`).send({
      memberIds: memberIds.slice(0, 4),
      action: "tag",
      payload: { tag },
    });
    expect(r.status, r.text).toBe(200);
    bucket = await latestBucketFor("tag", reason);

    // Strip the tag back off of 1 of the 4 → it's "already reversed".
    const [ext] = await db.select({
      id: memberProfileExtTable.id,
      internalTags: memberProfileExtTable.internalTags,
    }).from(memberProfileExtTable)
      .where(eq(memberProfileExtTable.clubMemberId, memberIds[0]));
    expect(ext).toBeDefined();
    await db.update(memberProfileExtTable).set({
      internalTags: (ext!.internalTags ?? []).filter((t: string) => t !== tag),
      updatedAt: new Date(),
    }).where(eq(memberProfileExtTable.id, ext!.id));
  });

  it("counts members still carrying the tag as willChange", async () => {
    const res = await callPreview({
      bucket, entity: "tag", reason, actorUserId: testUserId,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("tag");
    expect(res.body.affectedMembers).toBe(4);
    expect(res.body.willChange).toBe(3);
    expect(res.body.alreadyReversed).toBe(1);
  });

});

describe("POST /bulk-action/reverse/preview — tier_change bucket", () => {
  let bucket: string;
  let reason: string;

  beforeAll(async () => {
    // Use members 1..3 so this bucket doesn't trample the tag bucket above.
    const targets = memberIds.slice(1, 4);
    const r = await request(app).post(`${BASE()}/bulk-action`).send({
      memberIds: targets, action: "tier_change", payload: { tierId: restoreTierId },
    });
    expect(r.status, r.text).toBe(200);
    reason = `bulk tier_change → ${restoreTierId}`;
    bucket = await latestBucketFor("tier", reason);

    // Roll one member back to the originalTier so the preview classifies them
    // as already reversed; leaves the other two on restoreTier → willChange.
    await db.update(clubMembersTable).set({
      tierId: originalTierId, updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, targets[0]));
  });

  it("counts members back on the from-tier as alreadyReversed", async () => {
    const res = await callPreview({
      bucket, entity: "tier", reason, actorUserId: testUserId,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("tier_change");
    expect(res.body.affectedMembers).toBe(3);
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyReversed).toBe(1);
  });
});

describe("POST /bulk-action/reverse/preview — guards", () => {
  it("400s without bucket / entity", async () => {
    const r = await callPreview({ entity: "lifecycle", reason: "bulk freeze" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/bucket and entity/i);
  });

  it("rejects reversing a previously-applied reverse-of bucket", async () => {
    const r = await callPreview({
      bucket: new Date().toISOString(), entity: "lifecycle",
      reason: "bulk reverse-of #2025-01-01T00:00:00.000Z",
      actorUserId: testUserId,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/itself a reversal/i);
  });

  it("rejects buckets whose original action was bulk message (no inverse)", async () => {
    const r = await callPreview({
      bucket: new Date().toISOString(), entity: "message",
      reason: "bulk message (in_app)", actorUserId: testUserId,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cannot be reversed/i);
  });

  it("returns zeros for a bucket that matched no audit rows", async () => {
    const r = await callPreview({
      // Far-future bucket → no audit rows in the window.
      bucket: "2099-01-01T00:00:00.000Z",
      entity: "lifecycle", reason: "bulk freeze", actorUserId: testUserId,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      willChange: 0, alreadyReversed: 0, affectedMembers: 0, originalAction: "freeze",
    });
  });
});
