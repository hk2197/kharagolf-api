/**
 * Integration tests: per-member skip-list breakdown for the bulk-action redo
 * preview (Task #289 — covering the breakdown added by Task #258).
 *
 * Covers POST /api/organizations/:orgId/members-360/bulk-action/redo/preview
 * with includeMembers: true for each supported original action:
 *   - freeze
 *   - suspend
 *   - tag
 *   - tier_change
 *
 * For each action the cohort is split into "would-change" and "already in
 * target state" members, and the test asserts that the skippedMembers array
 * contains exactly the expected member ids (and only those).
 *
 * Also verifies back-compat: when includeMembers is not set (or false), the
 * skippedMembers field is omitted from the response.
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Test data is created in
 * beforeAll and cleaned in afterAll via cascade on the test organization.
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
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testUserId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let tierA: number;
let tierB: number;

const previewUrl = () =>
  `/api/organizations/${testOrgId}/members-360/bulk-action/redo/preview`;

async function createMember(
  first: string,
  last: string,
  opts: {
    tierId?: number | null;
    lifecycleStatus?: string;
    internalTags?: string[];
  } = {},
): Promise<number> {
  const [m] = await db
    .insert(clubMembersTable)
    .values({
      organizationId: testOrgId,
      firstName: first,
      lastName: last,
      email: `${first}.${last}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2, 8)}@example.com`,
      tierId: opts.tierId ?? null,
    })
    .returning({ id: clubMembersTable.id });
  await db.insert(memberProfileExtTable).values({
    clubMemberId: m.id,
    organizationId: testOrgId,
    lifecycleStatus: opts.lifecycleStatus ?? "active",
    internalTags: opts.internalTags ?? [],
  });
  return m.id;
}

async function insertAuditBucket(opts: {
  memberIds: number[];
  entity: string;
  reason: string;
  bucket: Date;
}) {
  for (const mid of opts.memberIds) {
    await db.insert(memberAuditLogTable).values({
      clubMemberId: mid,
      organizationId: testOrgId,
      entity: opts.entity,
      action: "update",
      reason: opts.reason,
      createdAt: opts.bucket,
    });
  }
}

async function ensureSchema() {
  // Drift safety: the test DB may lag the drizzle schema. Create the tables /
  // columns we touch so this suite is self-contained.
  await db.execute(
    sql`ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS shop_discount_pct numeric(5,2) NOT NULL DEFAULT '0'`,
  );
  await db.execute(
    sql`ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS shop_category_discounts jsonb`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_profile_ext (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      middle_name text,
      preferred_name text,
      salutation text,
      gender text,
      pronouns text,
      nationality text,
      occupation text,
      employer text,
      address_line1 text,
      address_line2 text,
      city text,
      state text,
      postal_code text,
      country text,
      emergency_contact_name text,
      emergency_contact_phone text,
      emergency_contact_relation text,
      preferred_tee text,
      dominant_hand text,
      preferred_cart text,
      shirt_size text,
      shoe_size text,
      gloves_size text,
      kyc_status text NOT NULL DEFAULT 'pending',
      kyc_verified_at timestamptz,
      kyc_verified_by_user_id integer,
      is_vip boolean NOT NULL DEFAULT false,
      internal_tags jsonb DEFAULT '[]'::jsonb,
      two_factor_enabled boolean NOT NULL DEFAULT false,
      two_factor_method text,
      joining_fee numeric(12,2) NOT NULL DEFAULT '0',
      refundable_deposit numeric(12,2) NOT NULL DEFAULT '0',
      credit_limit numeric(12,2) NOT NULL DEFAULT '0',
      lifecycle_status text NOT NULL DEFAULT 'active',
      lifecycle_status_until timestamptz,
      lifecycle_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_lifecycle_events (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      effective_from timestamptz NOT NULL DEFAULT now(),
      effective_until timestamptz,
      from_value text,
      to_value text,
      reason text,
      internal_notes text,
      fee_impact numeric(12,2),
      performed_by_user_id integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer,
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

  const stamp = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_RedoSkipList_${stamp}`,
      slug: `test-redo-skip-list-${stamp}`,
    })
    .returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `test-redo-skip-list-${stamp}`,
      username: `redo_skip_admin_${stamp}`,
      email: `redo_skip_${stamp}@example.com`,
      displayName: "Redo Skip Admin",
      role: "org_admin",
      organizationId: testOrgId,
    })
    .returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [ta] = await db
    .insert(membershipTiersTable)
    .values({ organizationId: testOrgId, name: `Silver_${stamp}` })
    .returning({ id: membershipTiersTable.id });
  tierA = ta.id;
  const [tb] = await db
    .insert(membershipTiersTable)
    .values({ organizationId: testOrgId, name: `Gold_${stamp}` })
    .returning({ id: membershipTiersTable.id });
  tierB = tb.id;

  admin = {
    id: testUserId,
    username: `redo_skip_admin_${stamp}`,
    displayName: "Redo Skip Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Org delete cascades members, ext, audit log, lifecycle events, tiers.
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db
      .delete(organizationsTable)
      .where(eq(organizationsTable.id, testOrgId));
  }
});

describe("POST /bulk-action/redo/preview — skipped-member breakdown", () => {
  it("freeze: skippedMembers = members already frozen", async () => {
    const bucket = new Date("2026-02-01T10:00:00.000Z");
    const willA = await createMember("Alice", "Adams", {
      lifecycleStatus: "active",
    });
    const willB = await createMember("Bob", "Brown", {
      lifecycleStatus: "active",
    });
    const skipA = await createMember("Carol", "Clark", {
      lifecycleStatus: "frozen",
    });
    const skipB = await createMember("Dave", "Doe", {
      lifecycleStatus: "frozen",
    });
    await insertAuditBucket({
      memberIds: [willA, willB, skipA, skipB],
      entity: "lifecycle",
      reason: "bulk freeze: winter break",
      bucket,
    });

    const res = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "lifecycle",
        reason: "bulk freeze: winter break",
        actorUserId: null,
        includeMembers: true,
      });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("freeze");
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyInTargetState).toBe(2);
    expect(res.body.affectedMembers).toBe(4);
    expect(Array.isArray(res.body.skippedMembers)).toBe(true);
    const skippedIds = (res.body.skippedMembers as Array<{ id: number }>)
      .map((m) => m.id)
      .sort((a, b) => a - b);
    expect(skippedIds).toEqual([skipA, skipB].sort((a, b) => a - b));
    // Returned ordering is by lastName, firstName: Clark before Doe.
    expect(res.body.skippedMembers.map((m: { lastName: string }) => m.lastName))
      .toEqual(["Clark", "Doe"]);
  });

  it("suspend: skippedMembers = members already suspended", async () => {
    const bucket = new Date("2026-02-01T11:00:00.000Z");
    const willA = await createMember("Eve", "Evans", {
      lifecycleStatus: "active",
    });
    const willB = await createMember("Frank", "Ford", {
      lifecycleStatus: "frozen", // frozen != suspended → will change
    });
    const skipA = await createMember("Grace", "Green", {
      lifecycleStatus: "suspended",
    });
    const skipB = await createMember("Hank", "Hill", {
      lifecycleStatus: "suspended",
    });
    await insertAuditBucket({
      memberIds: [willA, willB, skipA, skipB],
      entity: "lifecycle",
      reason: "bulk suspend: dues overdue",
      bucket,
    });

    const res = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "lifecycle",
        reason: "bulk suspend: dues overdue",
        actorUserId: null,
        includeMembers: true,
      });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("suspend");
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyInTargetState).toBe(2);
    const skippedIds = (res.body.skippedMembers as Array<{ id: number }>)
      .map((m) => m.id)
      .sort((a, b) => a - b);
    expect(skippedIds).toEqual([skipA, skipB].sort((a, b) => a - b));
  });

  it("tag: skippedMembers = members that already carry the tag", async () => {
    const bucket = new Date("2026-02-01T12:00:00.000Z");
    const tag = "VIP";
    const willA = await createMember("Ivy", "Irwin", { internalTags: [] });
    const willB = await createMember("Jack", "Jones", {
      internalTags: ["Other"],
    });
    const skipA = await createMember("Kate", "King", {
      internalTags: ["VIP"],
    });
    const skipB = await createMember("Liam", "Long", {
      internalTags: ["Other", "VIP"],
    });
    await insertAuditBucket({
      memberIds: [willA, willB, skipA, skipB],
      entity: "tag",
      reason: `bulk tag: ${tag}`,
      bucket,
    });

    const res = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "tag",
        reason: `bulk tag: ${tag}`,
        actorUserId: null,
        includeMembers: true,
      });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("tag");
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyInTargetState).toBe(2);
    const skippedIds = (res.body.skippedMembers as Array<{ id: number }>)
      .map((m) => m.id)
      .sort((a, b) => a - b);
    expect(skippedIds).toEqual([skipA, skipB].sort((a, b) => a - b));
  });

  it("tier_change: skippedMembers = members already on the target tier", async () => {
    const bucket = new Date("2026-02-01T13:00:00.000Z");
    // tierA = current for "will change" cohort, target = tierB.
    const willA = await createMember("Mia", "Moore", { tierId: tierA });
    const willB = await createMember("Noah", "Nash", { tierId: tierA });
    const skipA = await createMember("Olive", "Owens", { tierId: tierB });
    const skipB = await createMember("Pat", "Park", { tierId: tierB });
    const all = [willA, willB, skipA, skipB];
    await insertAuditBucket({
      memberIds: all,
      entity: "tier",
      reason: "bulk tier_change",
      bucket,
    });
    // Lifecycle events that record the redo target tier (tierB) for each.
    for (const mid of all) {
      await db.insert(memberLifecycleEventsTable).values({
        clubMemberId: mid,
        organizationId: testOrgId,
        eventType: "tier_change",
        toValue: String(tierB),
        createdAt: bucket,
        effectiveFrom: bucket,
      });
    }

    const res = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "tier",
        reason: "bulk tier_change",
        actorUserId: null,
        includeMembers: true,
      });
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalAction).toBe("tier_change");
    expect(res.body.willChange).toBe(2);
    expect(res.body.alreadyInTargetState).toBe(2);
    const skippedIds = (res.body.skippedMembers as Array<{ id: number }>)
      .map((m) => m.id)
      .sort((a, b) => a - b);
    expect(skippedIds).toEqual([skipA, skipB].sort((a, b) => a - b));
  });

  it("omits skippedMembers when includeMembers is not set (back-compat)", async () => {
    const bucket = new Date("2026-02-01T14:00:00.000Z");
    const willA = await createMember("Quinn", "Quill", {
      lifecycleStatus: "active",
    });
    const skipA = await createMember("Rose", "Reed", {
      lifecycleStatus: "frozen",
    });
    await insertAuditBucket({
      memberIds: [willA, skipA],
      entity: "lifecycle",
      reason: "bulk freeze: back-compat check",
      bucket,
    });

    // Default — no includeMembers.
    const resDefault = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "lifecycle",
        reason: "bulk freeze: back-compat check",
        actorUserId: null,
      });
    expect(resDefault.status, resDefault.text).toBe(200);
    expect(resDefault.body.willChange).toBe(1);
    expect(resDefault.body.alreadyInTargetState).toBe(1);
    expect(resDefault.body).not.toHaveProperty("skippedMembers");

    // Explicit false — same back-compat behaviour.
    const resFalse = await request(app)
      .post(previewUrl())
      .send({
        bucket: bucket.toISOString(),
        entity: "lifecycle",
        reason: "bulk freeze: back-compat check",
        actorUserId: null,
        includeMembers: false,
      });
    expect(resFalse.status, resFalse.text).toBe(200);
    expect(resFalse.body).not.toHaveProperty("skippedMembers");
  });
});
