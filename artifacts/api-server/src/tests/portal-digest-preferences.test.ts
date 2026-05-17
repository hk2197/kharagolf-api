/**
 * Task #1832 — `/api/portal/digest-preferences` enumerates the user-scoped
 * email-digest subscriptions managed by the shared registry, and PATCH flips
 * a single digest's opted-in state with an audit row.
 *
 * Coverage:
 *   - GET requires auth and returns the registry's controller-facing
 *     user-level digests (today: just `member_prefs_digest`) defaulted to
 *     opted-in.
 *   - GET returns an empty list for non-controller users (players /
 *     spectators) so the consolidated "Email digests" section is hidden
 *     for users who would never receive any digest.
 *   - GET excludes `erasure_storage_digest` even for eligible
 *     controllers — it has its own dedicated UI row in
 *     `PortalCommPrefs.tsx` (Tasks #1449 / #1772 / #1774) and listing it
 *     here would create a second source of truth on the same screen.
 *   - PATCH validates `optedIn`, rejects unknown / per-org-only digest ids,
 *     rejects digests without `portalListing` (incl. `erasure_storage_digest`),
 *     persists the toggle, is idempotent, and round-trips on subsequent GETs.
 *   - PATCH writes a `member_audit_log` row with `source =
 *     "portal_digest_settings"` mirroring the public unsubscribe handler.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let controllerUserId: number;
let nonControllerUserId: number;
let orgId: number;

beforeAll(async () => {
  // A standalone org is required so we can attach a controller-level
  // membership row — the eligibility filter checks both the direct
  // `app_users.role === 'org_admin'` shortcut and the
  // `org_memberships.role IN (...)` membership-table path. We exercise
  // the membership path here to mirror the typical
  // committee-member-with-elevated-role real-world setup.
  const orgTag = uid("portal-digest-prefs-org");
  const [org] = await db.insert(organizationsTable).values({
    slug: orgTag,
    name: "Digest Prefs Test Org",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const tag = uid("portal-digest-prefs");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    displayName: "Digest Prefs Controller",
    email: `${tag}@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  controllerUserId = u.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: controllerUserId,
    role: "membership_secretary",
  });

  // A second user with no controller-level role to verify the
  // eligibility gate hides the section for ordinary players.
  const nonTag = uid("portal-digest-prefs-noctrl");
  const [nonU] = await db.insert(appUsersTable).values({
    replitUserId: nonTag,
    username: nonTag,
    displayName: "Plain Player",
    email: `${nonTag}@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  nonControllerUserId = nonU.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable)
    .where(eq(memberAuditLogTable.entityId, controllerUserId));
  await db.delete(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, controllerUserId));
  await db.delete(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, nonControllerUserId));
  await db.delete(orgMembershipsTable)
    .where(eq(orgMembershipsTable.userId, controllerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, controllerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonControllerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/portal/digest-preferences", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/portal/digest-preferences");
    expect(res.status).toBe(401);
  });

  it("lists controller-eligible user-scoped digests (defaults to opted-in)", async () => {
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });
    const res = await request(app).get("/api/portal/digest-preferences");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.digests)).toBe(true);

    const ids = (res.body.digests as Array<{ id: string }>).map((d) => d.id).sort();
    // `member_prefs_digest` is the only consolidated entry today —
    // `erasure_storage_digest` is intentionally omitted because it has
    // its own dedicated UI row (Tasks #1449 / #1772 / #1774).
    expect(ids).toEqual(["member_prefs_digest"]);

    for (const d of res.body.digests as Array<{ optedIn: boolean }>) {
      expect(d.optedIn).toBe(true);
    }
    // The per-(user,org) bounced-digest schedule must NOT appear here.
    expect(ids).not.toContain("bounced_digest_schedule");
    // Belt-and-braces: the dedicated-UI digest must stay out of the
    // consolidated listing even though it's user-scoped.
    expect(ids).not.toContain("erasure_storage_digest");
  });

  it("returns an empty list for non-controller users (eligibility gate)", async () => {
    const app = createTestApp({ id: nonControllerUserId, username: "u", role: "player" });
    const res = await request(app).get("/api/portal/digest-preferences");
    expect(res.status).toBe(200);
    expect(res.body.digests).toEqual([]);
  });
});

describe("PATCH /api/portal/digest-preferences/:id", () => {
  it("rejects a non-boolean optedIn", async () => {
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/digest-preferences/member_prefs_digest")
      .send({ optedIn: "no" });
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-controller users (eligibility gate mirrors GET)", async () => {
    // The UI hides the section for non-controllers, but a hand-rolled
    // request shouldn't be able to flip an inert preference either —
    // PATCH applies the same `isControllerEligibleForAnyOrg` gate as
    // GET to keep the read-vs-write surfaces consistent.
    const app = createTestApp({ id: nonControllerUserId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/digest-preferences/member_prefs_digest")
      .send({ optedIn: false });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown digest id", async () => {
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/digest-preferences/not_a_real_digest")
      .send({ optedIn: false });
    expect(res.status).toBe(404);
  });

  it("returns 404 for the per-org bounced digest (not user-scoped)", async () => {
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/digest-preferences/bounced_digest_schedule")
      .send({ optedIn: false });
    expect(res.status).toBe(404);
  });

  it("returns 404 for digests without `portalListing` (erasure_storage_digest)", async () => {
    // The stuck-erasure digest is user-scoped, but its email toggle is
    // owned by the older notification-prefs PATCH so the consolidated
    // endpoint must refuse to write it. This guards against the
    // "two-sources-of-truth" drift that motivated Task #1832.
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });
    const res = await request(app)
      .patch("/api/portal/digest-preferences/erasure_storage_digest")
      .send({ optedIn: false });
    expect(res.status).toBe(404);
  });

  it("persists the opt-out, is idempotent, and writes an audit row", async () => {
    const app = createTestApp({ id: controllerUserId, username: "u", role: "player" });

    // Flip off.
    const off = await request(app)
      .patch("/api/portal/digest-preferences/member_prefs_digest")
      .send({ optedIn: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({
      id: "member_prefs_digest",
      optedIn: false,
      previousOptedIn: true,
    });

    // GET reflects it.
    const get1 = await request(app).get("/api/portal/digest-preferences");
    const memberPrefs = (get1.body.digests as Array<{ id: string; optedIn: boolean }>)
      .find((d) => d.id === "member_prefs_digest");
    expect(memberPrefs?.optedIn).toBe(false);

    // Idempotent re-flip-off does not create a second audit row.
    const beforeCount = await db
      .select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.entityId, controllerUserId));
    const off2 = await request(app)
      .patch("/api/portal/digest-preferences/member_prefs_digest")
      .send({ optedIn: false });
    expect(off2.status).toBe(200);
    expect(off2.body.previousOptedIn).toBe(false);
    const afterCount = await db
      .select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.entityId, controllerUserId));
    expect(afterCount.length).toBe(beforeCount.length);

    // Audit row mirrors the public-unsubscribe handler shape.
    const auditRows = await db
      .select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entityId, controllerUserId),
        eq(memberAuditLogTable.entity, "comm_prefs"),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    expect(auditRows.length).toBe(1);
    const row = auditRows[0];
    expect(row.action).toBe("update");
    // The audit row is anchored to one of the user's controller orgs
    // (FK requires a real org id) — we exercised the membership-table
    // path in `beforeAll` so the anchor is the test org we created.
    expect(row.organizationId).toBe(orgId);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.source).toBe("portal_digest_settings");
    expect(meta.scope).toBe("user_level");
    expect(meta.kind).toBe("member_prefs_digest");
    expect(meta.direction).toBe("unsubscribe");
    expect(meta.targetUserId).toBe(controllerUserId);
    const changes = row.fieldChanges as Record<string, { from: boolean; to: boolean }>;
    expect(changes.notifyMemberPrefsDigest).toEqual({ from: true, to: false });

    // Flip back on for cleanliness.
    const reset = await request(app)
      .patch("/api/portal/digest-preferences/member_prefs_digest")
      .send({ optedIn: true });
    expect(reset.body.optedIn).toBe(true);
  });
});
