/**
 * Tests for Task #1454 — public erasure-digest unsubscribe / re-subscribe
 * endpoints leave a member_audit_log paper trail, and the portal
 * notification-preferences GET surfaces a "last changed via unsubscribe
 * link on <date>" hint next to the toggle.
 *
 * Covers:
 *   - Hitting /api/public/erasure-digest-unsubscribe writes a comm_prefs
 *     audit row scoped to the org from the token, with a from→true / to→false
 *     fieldChanges entry and a metadata.source = "public_unsubscribe_link"
 *     marker.
 *   - Hitting /api/public/erasure-digest-resubscribe writes a second audit
 *     row with direction = "resubscribe" and from→false / to→true.
 *   - GET /api/portal/notification-preferences exposes the most recent
 *     link-driven change as `notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt`
 *     plus a `...Direction` field, and returns null for both when the user
 *     has never used the email link.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { signErasureStorageDigestOptOutToken } from "../lib/bouncedDigestUnsubscribe.js";
import publicRouter from "../routes/public.js";
import { createTestApp, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let auditedOrgId: number;
let auditedUserId: number;
let neverClickedUserId: number;

beforeAll(async () => {
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
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest boolean NOT NULL DEFAULT true`);

  const tag = uid("erasure-link-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `Erasure Link Audit Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  auditedOrgId = org.id;
  createdOrgIds.push(org.id);

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-controller`,
    username: `${tag}_controller`,
    displayName: "Audit Controller",
    email: `${tag}-controller@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  auditedUserId = u1.id;
  createdUserIds.push(u1.id);
  await db.insert(orgMembershipsTable).values({
    organizationId: auditedOrgId,
    userId: auditedUserId,
    role: "org_admin",
  });

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-clean`,
    username: `${tag}_clean`,
    displayName: "Never Clicked",
    email: `${tag}-clean@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  neverClickedUserId = u2.id;
  createdUserIds.push(u2.id);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

function buildPublicApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/api/public", publicRouter);
  return app;
}

describe("Task #1454 — erasure-digest link writes member_audit_log", () => {
  it("records a comm_prefs audit row with from→to fieldChanges on unsubscribe", async () => {
    const app = buildPublicApp();
    const token = signErasureStorageDigestOptOutToken(auditedUserId, auditedOrgId);

    await request(app)
      .get(`/api/public/erasure-digest-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);

    const auditRows = await db.select({
      entity: memberAuditLogTable.entity,
      action: memberAuditLogTable.action,
      entityId: memberAuditLogTable.entityId,
      organizationId: memberAuditLogTable.organizationId,
      fieldChanges: memberAuditLogTable.fieldChanges,
      metadata: memberAuditLogTable.metadata,
      reason: memberAuditLogTable.reason,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, auditedUserId),
        eq(memberAuditLogTable.organizationId, auditedOrgId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.action).toBe("update");
    expect(row.reason).toBe("Public unsubscribe link clicked");
    expect(row.fieldChanges).toEqual({
      notifyErasureStorageDigest: { from: true, to: false },
    });
    expect(row.metadata).toMatchObject({
      source: "public_unsubscribe_link",
      kind: "erasure_storage_digest",
      direction: "unsubscribe",
      targetUserId: auditedUserId,
    });
  });

  it("records a second audit row with direction='resubscribe' on resubscribe", async () => {
    const app = buildPublicApp();
    const token = signErasureStorageDigestOptOutToken(auditedUserId, auditedOrgId);

    await request(app)
      .get(`/api/public/erasure-digest-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);

    const auditRows = await db.select({
      fieldChanges: memberAuditLogTable.fieldChanges,
      metadata: memberAuditLogTable.metadata,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, auditedUserId),
        eq(memberAuditLogTable.organizationId, auditedOrgId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));

    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    const newest = auditRows[0];
    expect(newest.fieldChanges).toEqual({
      notifyErasureStorageDigest: { from: false, to: true },
    });
    expect(newest.metadata).toMatchObject({
      source: "public_unsubscribe_link",
      kind: "erasure_storage_digest",
      direction: "resubscribe",
    });
  });
});

describe("Task #1454 — portal GET notification-preferences exposes the link-change hint", () => {
  it("returns the timestamp + direction of the most recent link-driven change", async () => {
    const portal = createTestApp({ id: auditedUserId, username: "ctrl", role: "org_admin" });
    const res = await request(portal).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(typeof res.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBe("string");
    // ISO 8601 string
    expect(res.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Most recent action above is "resubscribe".
    expect(res.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBe("resubscribe");
  });

  it("returns null hint fields for a controller who has never used the email link", async () => {
    const portal = createTestApp({ id: neverClickedUserId, username: "clean", role: "org_admin" });
    const res = await request(portal).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBeNull();
    expect(res.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBeNull();
  });
});
