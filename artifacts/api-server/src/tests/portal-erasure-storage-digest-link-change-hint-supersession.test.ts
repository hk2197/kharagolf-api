/**
 * Task #2215 — the "Last changed via email link on <date>" hint shown
 * below the Stuck-erasure cleanup digest toggle on the portal must
 * disappear once the controller subsequently flips the same toggle from
 * the in-portal settings page (PATCH `/api/portal/notification-
 * preferences`). Until this task the hint persisted indefinitely
 * because the GET handler always returned the most recent
 * `member_audit_log` row written by the public unsubscribe link,
 * regardless of any later in-portal change. That made the date
 * misleading: it read as if the most recent change came from the email
 * link when in fact a newer in-portal change had superseded it.
 *
 * The fix has two parts:
 *   1. PATCH writes its own `member_audit_log` row (entity = "comm_prefs",
 *      metadata.kind = "erasure_storage_digest", metadata.source =
 *      "portal_notification_preferences") whenever the toggle truly flips.
 *   2. GET fetches the LATEST comm_prefs/erasure_storage_digest audit
 *      row regardless of source and only surfaces the link-change hint
 *      when that latest row is the public unsubscribe-link click.
 *
 * Together these make the hint disappear after a portal-side toggle
 * (link → portal transition) and reappear if the controller then
 * re-uses the email link (portal → link transition).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { and, eq, sql, desc } from "drizzle-orm";
import { signErasureStorageDigestOptOutToken } from "../lib/bouncedDigestUnsubscribe.js";
import publicRouter from "../routes/public.js";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  // The shared test setup creates the schema, but a couple of tests
  // start from a bare DB. Re-create the table + columns we touch so
  // this file is robust to running standalone.
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

  const tag = uid("erasure-link-hint-supersession");
  const [org] = await db.insert(organizationsTable).values({
    name: `Erasure Link Hint Supersession ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-controller`,
    username: `${tag}_controller`,
    displayName: "Hint Supersession Controller",
    email: `${tag}@example.com`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "comm_prefs"),
    eq(memberAuditLogTable.entityId, userId),
  ));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Reset prefs + this user's comm_prefs audit rows between tests so
  // each case starts from the schema default (notify_erasure_storage_digest
  // = true) and a clean audit timeline. Clearing only THIS user's rows
  // keeps the suite parallel-safe with other test files in the folder.
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "comm_prefs"),
    eq(memberAuditLogTable.entityId, userId),
  ));
});

function buildPublicApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/api/public", publicRouter);
  return app;
}

async function clickUnsubscribeLink() {
  const pub = buildPublicApp();
  const token = signErasureStorageDigestOptOutToken(userId, orgId);
  await request(pub)
    .get(`/api/public/erasure-digest-unsubscribe?token=${encodeURIComponent(token)}`)
    .expect(200);
}

async function listErasureDigestAuditRows() {
  return db
    .select({
      id: memberAuditLogTable.id,
      metadata: memberAuditLogTable.metadata,
      fieldChanges: memberAuditLogTable.fieldChanges,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "comm_prefs"),
      eq(memberAuditLogTable.entityId, userId),
      sql`${memberAuditLogTable.metadata}->>'kind' = 'erasure_storage_digest'`,
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));
}

describe("Task #2215 — link → portal transition hides the link-change hint", () => {
  it("returns the hint after only the email link click, then null after a portal-side flip", async () => {
    const portal = createTestApp({ id: userId, username: "ctrl", role: "org_admin", organizationId: orgId });

    // 1) Controller clicks the email's one-click unsubscribe link.
    await clickUnsubscribeLink();

    // GET should expose the link-change hint with direction=unsubscribe.
    const beforeRes = await request(portal).get("/api/portal/notification-preferences");
    expect(beforeRes.status).toBe(200);
    expect(typeof beforeRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBe("string");
    expect(beforeRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBe("unsubscribe");

    // 2) Controller flips the toggle back ON from the portal settings page.
    const patch = await request(portal)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: true });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyErasureStorageDigest).toBe(true);

    // The PATCH must have written a portal-source audit row that
    // supersedes the link-driven one in the GET query.
    const rows = await listErasureDigestAuditRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const newest = rows[0];
    expect(newest.metadata).toMatchObject({
      source: "portal_notification_preferences",
      kind: "erasure_storage_digest",
      direction: "resubscribe",
      targetUserId: userId,
    });
    expect(newest.fieldChanges).toEqual({
      notifyErasureStorageDigest: { from: false, to: true },
    });

    // 3) GET must now hide the hint — the latest change was in-portal,
    // not the email link, so the "Last changed via email link" line
    // would be misleading.
    const afterRes = await request(portal).get("/api/portal/notification-preferences");
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBeNull();
    expect(afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBeNull();
  });

  it("does NOT hide the hint when the PATCH supplies an unrelated field (no-op for this toggle)", async () => {
    const portal = createTestApp({ id: userId, username: "ctrl", role: "org_admin", organizationId: orgId });

    await clickUnsubscribeLink();

    // PATCH a different preference — `notifyErasureStorageDigest` is
    // not supplied, so no portal-source audit row should be written
    // and the hint must stay visible. This guards against a future
    // refactor that accidentally writes the audit row on every save.
    const patch = await request(portal)
      .patch("/api/portal/notification-preferences")
      .send({ preferPush: false });
    expect(patch.status).toBe(200);

    const afterRes = await request(portal).get("/api/portal/notification-preferences");
    expect(afterRes.status).toBe(200);
    expect(typeof afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBe("string");
    expect(afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBe("unsubscribe");
  });

  it("does NOT hide the hint when PATCH echoes the same value (no true change → no audit row)", async () => {
    const portal = createTestApp({ id: userId, username: "ctrl", role: "org_admin", organizationId: orgId });

    // The unsubscribe link sets `notifyErasureStorageDigest = false`.
    await clickUnsubscribeLink();

    // PATCH echoes the same false — no transition, so no audit row.
    const patch = await request(portal)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyErasureStorageDigest).toBe(false);

    const rows = await listErasureDigestAuditRows();
    // Only the link-driven row from `clickUnsubscribeLink()` above.
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ source: "public_unsubscribe_link" });

    const afterRes = await request(portal).get("/api/portal/notification-preferences");
    expect(afterRes.status).toBe(200);
    expect(typeof afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBe("string");
    expect(afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBe("unsubscribe");
  });
});

describe("Task #2215 — portal → link transition restores the link-change hint", () => {
  it("hides the hint after a portal-side flip, then re-shows it after a fresh email-link click", async () => {
    const portal = createTestApp({ id: userId, username: "ctrl", role: "org_admin", organizationId: orgId });

    // 1) Controller mutes the digest from the portal first (no link
    // click yet). The hint must NOT show — there's no link-driven
    // row in the timeline at all.
    const off = await request(portal)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false });
    expect(off.status).toBe(200);

    const beforeRes = await request(portal).get("/api/portal/notification-preferences");
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBeNull();
    expect(beforeRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBeNull();

    // 2) Now the controller clicks the email's re-subscribe link
    // (the public re-subscribe endpoint flips the flag back to true
    // and writes a `direction: "resubscribe"` audit row).
    const pub = buildPublicApp();
    const token = signErasureStorageDigestOptOutToken(userId, orgId);
    await request(pub)
      .get(`/api/public/erasure-digest-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);

    // 3) GET must re-show the hint — the latest change is now the
    // link click again, even though earlier portal-side rows exist.
    const afterRes = await request(portal).get("/api/portal/notification-preferences");
    expect(afterRes.status).toBe(200);
    expect(typeof afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt).toBe("string");
    expect(afterRes.body.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection).toBe("resubscribe");
  });
});
