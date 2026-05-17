/**
 * Tests for the admin "Last digest sent" panel endpoint (Task #1831).
 *
 * Endpoint: GET /organizations/:orgId/members/notification-prefs/last-digest
 *
 * The monthly `sendMemberPrefsDigest` cron writes a `member_audit_log`
 * row (entity='comm_prefs', action='member_prefs_digest_sent') with
 * recipients + counts in `metadata`. Admins want a small panel on the
 * notification-prefs page so they can confirm who received the last
 * digest without poking the audit log table directly.
 *
 * Covers:
 *   - 401 anonymous, 403 non-admin / wrong-org admin
 *   - Returns `{ lastDigest: null }` when no audit row exists
 *   - 200 org_admin gets the latest digest with parsed metadata
 *   - Picks the most recent row when multiple exist
 *   - Does not leak rows from other organizations
 *   - Defensive parsing tolerates missing/malformed metadata fields
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let emptyOrgId: number;
let adminUserId: number;
let nonAdminUserId: number;
let otherOrgAdminUserId: number;
let emptyOrgAdminUserId: number;

let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsNonAdmin: ReturnType<typeof createTestApp>;
let appAsOtherOrgAdmin: ReturnType<typeof createTestApp>;
let appAsEmptyOrgAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

const insertedAuditIds: number[] = [];

async function makeUser(suffix: string) {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `last-digest-${suffix}-${stamp}`,
    username: `last_digest_${suffix}_${stamp}`,
    email: `last_digest_${suffix}_${stamp}@example.com`,
    displayName: `LastDigest ${suffix}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  return u.id;
}

async function insertDigestAudit(opts: {
  organizationId: number;
  metadata: Record<string, unknown> | null;
  createdAt?: Date;
}) {
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: opts.organizationId,
    clubMemberId: null,
    actorUserId: null,
    actorName: "system",
    actorRole: null,
    entity: "comm_prefs",
    entityId: null,
    action: "member_prefs_digest_sent",
    fieldChanges: null,
    reason: "Monthly member notification-preferences digest",
    metadata: opts.metadata,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).returning({ id: memberAuditLogTable.id });
  insertedAuditIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `LastDigest_${stamp}`,
    slug: `last-digest-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `LastDigestOther_${stamp}`,
    slug: `last-digest-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [emptyOrg] = await db.insert(organizationsTable).values({
    name: `LastDigestEmpty_${stamp}`,
    slug: `last-digest-empty-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  emptyOrgId = emptyOrg.id;

  adminUserId = await makeUser("admin");
  nonAdminUserId = await makeUser("nonadmin");
  otherOrgAdminUserId = await makeUser("otheradmin");
  emptyOrgAdminUserId = await makeUser("emptyadmin");

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: orgId, userId: nonAdminUserId, role: "player" },
    { organizationId: otherOrgId, userId: otherOrgAdminUserId, role: "org_admin" },
    { organizationId: emptyOrgId, userId: emptyOrgAdminUserId, role: "org_admin" },
  ]);

  // Older row — should be ignored when we ask for the LATEST.
  await insertDigestAudit({
    organizationId: orgId,
    metadata: {
      source: "cron",
      kind: "member_prefs_digest",
      period: "2026-02",
      sentAt: "2026-02-01T03:00:00.000Z",
      memberRows: 5,
      filename: `member-notification-prefs-org-${orgId}.csv`,
      recipientsEmailed: 1,
      recipientsSuppressed: 0,
      recipients: [{ userId: adminUserId, email: `admin@example.com` }],
    },
    createdAt: new Date("2026-02-01T03:00:00.000Z"),
  });

  // Newest row — this is what the endpoint must return.
  await insertDigestAudit({
    organizationId: orgId,
    metadata: {
      source: "cron",
      kind: "member_prefs_digest",
      period: "2026-04",
      sentAt: "2026-04-01T03:00:00.000Z",
      memberRows: 9,
      filename: `member-notification-prefs-org-${orgId}.csv`,
      recipientsEmailed: 2,
      recipientsSuppressed: 1,
      recipients: [
        { userId: adminUserId, email: `admin@example.com` },
        { userId: nonAdminUserId, email: `secretary@example.com` },
        // Malformed entries (missing required fields) — defensive parsing
        // must drop them rather than 500 the panel.
        { userId: 12345 },
        { email: "no-id@example.com" },
        "string-not-object",
        null,
      ],
    },
    createdAt: new Date("2026-04-01T03:00:00.000Z"),
  });

  // Cross-org row — must NEVER appear in the in-org response.
  await insertDigestAudit({
    organizationId: otherOrgId,
    metadata: {
      source: "cron",
      kind: "member_prefs_digest",
      period: "2026-04",
      sentAt: "2026-04-01T03:00:00.000Z",
      memberRows: 99,
      filename: `member-notification-prefs-org-${otherOrgId}.csv`,
      recipientsEmailed: 7,
      recipientsSuppressed: 0,
      recipients: [{ userId: otherOrgAdminUserId, email: "leak@example.com" }],
    },
    createdAt: new Date("2026-04-01T03:05:00.000Z"),
  });

  appAsAdmin = createTestApp({ id: adminUserId, username: `last_digest_admin_${stamp}`, role: "org_admin", organizationId: orgId });
  appAsNonAdmin = createTestApp({ id: nonAdminUserId, username: `last_digest_nonadmin_${stamp}`, role: "player", organizationId: orgId });
  const otherAdmin: TestUser = {
    id: otherOrgAdminUserId,
    username: `last_digest_otheradmin_${stamp}`,
    role: "org_admin",
    organizationId: otherOrgId,
  };
  appAsOtherOrgAdmin = createTestApp(otherAdmin);
  appAsEmptyOrgAdmin = createTestApp({
    id: emptyOrgAdminUserId,
    username: `last_digest_emptyadmin_${stamp}`,
    role: "org_admin",
    organizationId: emptyOrgId,
  });
  appAnonymous = createTestApp();
});

afterAll(async () => {
  if (insertedAuditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, insertedAuditIds));
  }
  const userIds = [adminUserId, nonAdminUserId, otherOrgAdminUserId, emptyOrgAdminUserId].filter(Boolean);
  if (userIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
  if (emptyOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, emptyOrgId));
});

describe("GET /organizations/:orgId/members/notification-prefs/last-digest", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous)
      .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin caller in the same org", async () => {
    const res = await request(appAsNonAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an admin of a different org", async () => {
    const res = await request(appAsOtherOrgAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
    expect(res.status).toBe(403);
  });

  it("returns { lastDigest: null } when no audit row exists", async () => {
    const res = await request(appAsEmptyOrgAdmin)
      .get(`/api/organizations/${emptyOrgId}/members/notification-prefs/last-digest`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ lastDigest: null });
  });

  it("returns the latest digest row with parsed metadata", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.lastDigest).not.toBeNull();
    const ld = res.body.lastDigest;
    expect(ld.period).toBe("2026-04");
    expect(ld.sentAt).toBe("2026-04-01T03:00:00.000Z");
    expect(ld.memberRows).toBe(9);
    expect(ld.recipientsEmailed).toBe(2);
    expect(ld.recipientsSuppressed).toBe(1);
    expect(ld.filename).toBe(`member-notification-prefs-org-${orgId}.csv`);
    // Only the well-formed entries survive defensive parsing — malformed
    // entries (missing userId / missing email / wrong type) are dropped.
    expect(Array.isArray(ld.recipients)).toBe(true);
    expect(ld.recipients).toHaveLength(2);
    expect(ld.recipients).toEqual(
      expect.arrayContaining([
        { userId: adminUserId, email: "admin@example.com" },
        { userId: nonAdminUserId, email: "secretary@example.com" },
      ]),
    );
  });

  it("does not leak digest rows from other organizations", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
    expect(res.status).toBe(200);
    // The cross-org row's filename + recipient email should never surface.
    expect(JSON.stringify(res.body)).not.toContain(`member-notification-prefs-org-${otherOrgId}.csv`);
    expect(JSON.stringify(res.body)).not.toContain("leak@example.com");
  });

  it("tolerates missing/malformed metadata gracefully (no 500)", async () => {
    // Insert a row whose metadata is missing every optional field, then
    // confirm the endpoint still returns a usable shape rather than 500ing.
    // We bracket the test by deleting this extra row at the end so the
    // earlier "latest digest" assertion is unaffected by execution order.
    const id = await insertDigestAudit({
      organizationId: orgId,
      metadata: { /* no recipients, no sentAt, no counts */ },
      createdAt: new Date("2026-05-01T03:00:00.000Z"),
    });
    try {
      const res = await request(appAsAdmin)
        .get(`/api/organizations/${orgId}/members/notification-prefs/last-digest`);
      expect(res.status, res.text).toBe(200);
      const ld = res.body.lastDigest;
      expect(ld).not.toBeNull();
      // sentAt falls back to the audit row's createdAt timestamp.
      expect(typeof ld.sentAt).toBe("string");
      expect(new Date(ld.sentAt).toISOString()).toBe("2026-05-01T03:00:00.000Z");
      expect(ld.period).toBeNull();
      expect(ld.filename).toBeNull();
      expect(ld.memberRows).toBe(0);
      expect(ld.recipientsEmailed).toBe(0);
      expect(ld.recipientsSuppressed).toBe(0);
      expect(ld.recipients).toEqual([]);
    } finally {
      await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.id, id));
      const idx = insertedAuditIds.indexOf(id);
      if (idx >= 0) insertedAuditIds.splice(idx, 1);
    }
  });
});
