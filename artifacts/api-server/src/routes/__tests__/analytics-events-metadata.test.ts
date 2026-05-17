/**
 * Task #1571 — GET/PUT/DELETE /api/organizations/:orgId/analytics/events/metadata
 *
 * Pins the contract for the per-org "Customize events" surface (Task
 * #1318) so the dashboard's friendly labels, descriptions, and chart
 * colors keep working as more flows get instrumented.
 *
 * Behaviours that matter and were untested:
 *   • requireOrgAdmin gating
 *       — 401 when unauthenticated
 *       — 403 for a non-admin role (player) in the same org
 *       — 403 for an org_admin in a *different* org (no cross-tenant
 *         peeking via /:orgId path traversal)
 *       — super_admin can read/write metadata in any org
 *   • Hex color validation on PUT — `#3b82f6` and `#abc` accepted, `red`
 *     rejected with 400 and a helpful message; the row is NOT written.
 *   • Event name validation on PUT/DELETE — names matching the
 *     [A-Za-z0-9_.-]{1,128} regex are accepted; whitespace/garbage is 400.
 *   • Upsert semantics — a second PUT for the same (org, eventName)
 *     overwrites displayName/description/color rather than inserting a
 *     duplicate row, and bumps updatedAt.
 *   • DELETE removes only the (orgId, eventName) row — sibling events
 *     in the same org and the same event in another org are untouched.
 *   • GET returns every override for the requesting org (and only that
 *     org), regardless of whether the event has fired recently.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  analyticsEventMetadataTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let superAdminId: number;

const seededEvents = new Set<string>();
function trackEvent(name: string) { seededEvents.add(name); return name; }

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1571_A_${stamp}`, slug: `t1571-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1571_B_${stamp}`, slug: `t1571-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1571-admin-a-${stamp}`,
    username: `t1571_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1571.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1571-admin-b-${stamp}`,
    username: `t1571_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1571.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1571-player-a-${stamp}`,
    username: `t1571_player_a_${stamp}`,
    email: `player_a_${stamp}@t1571.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [superUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1571-super-${stamp}`,
    username: `t1571_super_${stamp}`,
    email: `super_${stamp}@t1571.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superUser.id;
});

afterAll(async () => {
  // Clean up every metadata row we touched (in either org). Doing it by
  // (orgId IN, eventName IN) is safe because the event names embed our
  // run-specific stamp.
  if (seededEvents.size > 0 && (orgAId || orgBId)) {
    const orgs = [orgAId, orgBId].filter((v): v is number => typeof v === "number");
    await db.delete(analyticsEventMetadataTable).where(and(
      inArray(analyticsEventMetadataTable.organizationId, orgs),
      inArray(analyticsEventMetadataTable.eventName, Array.from(seededEvents)),
    ));
  }
  const allUsers = [adminAId, adminBId, playerAId, superAdminId]
    .filter((v): v is number => typeof v === "number");
  if (allUsers.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUsers));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

function metaUrl(orgId: number, eventName?: string): string {
  const base = `/api/organizations/${orgId}/analytics/events/metadata`;
  return eventName ? `${base}/${encodeURIComponent(eventName)}` : base;
}

interface ListBody {
  metadata: Array<{
    eventName: string;
    displayName: string | null;
    description: string | null;
    color: string | null;
    updatedAt: string;
  }>;
}

interface UpsertBody {
  metadata: {
    eventName: string;
    displayName: string | null;
    description: string | null;
    color: string | null;
    updatedAt: string;
  };
}

describe("/api/organizations/:orgId/analytics/events/metadata — auth gating", () => {
  it("returns 401 on GET when unauthenticated", async () => {
    const res = await request(createTestApp()).get(metaUrl(orgAId));
    expect(res.status).toBe(401);
  });

  it("returns 401 on PUT when unauthenticated", async () => {
    const res = await request(createTestApp())
      .put(metaUrl(orgAId, "t1571_unauth_put"))
      .send({ displayName: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 401 on DELETE when unauthenticated", async () => {
    const res = await request(createTestApp())
      .delete(metaUrl(orgAId, "t1571_unauth_del"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a player on GET", async () => {
    const res = await request(createTestApp(asUser(playerAId, "player", orgAId)))
      .get(metaUrl(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org_admin requests a different org's metadata", async () => {
    const res = await request(createTestApp(asUser(adminBId, "org_admin", orgBId)))
      .get(metaUrl(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org_admin tries to PUT into a different org", async () => {
    const eventName = trackEvent("t1571_cross_tenant_put");
    const res = await request(createTestApp(asUser(adminBId, "org_admin", orgBId)))
      .put(metaUrl(orgAId, eventName))
      .send({ displayName: "Should not write", color: "#3b82f6" });
    expect(res.status).toBe(403);

    // Verify nothing was written for this event in either org.
    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(eq(analyticsEventMetadataTable.eventName, eventName));
    expect(rows).toHaveLength(0);
  });

  it("returns 403 when an org_admin tries to DELETE in a different org and leaves the row intact", async () => {
    const eventName = trackEvent("t1571_cross_tenant_del");
    // Org A admin seeds the row.
    await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .put(metaUrl(orgAId, eventName))
      .send({ displayName: "Owned by A" }).expect(200);

    // Org B admin tries to delete it via org A's path.
    const res = await request(createTestApp(asUser(adminBId, "org_admin", orgBId)))
      .delete(metaUrl(orgAId, eventName));
    expect(res.status).toBe(403);

    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgAId),
        eq(analyticsEventMetadataTable.eventName, eventName),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Owned by A");
  });
});

describe("PUT /api/organizations/:orgId/analytics/events/metadata/:eventName", () => {
  it("upserts a row with displayName/description/color and returns it", async () => {
    const eventName = trackEvent("t1571_login_evt");
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .put(metaUrl(orgAId, eventName))
      .send({
        displayName: "Player Login",
        description: "Fires on every successful sign-in",
        color: "#3b82f6",
      });
    expect(res.status).toBe(200);
    const body = res.body as UpsertBody;
    expect(body.metadata.eventName).toBe(eventName);
    expect(body.metadata.displayName).toBe("Player Login");
    expect(body.metadata.description).toBe("Fires on every successful sign-in");
    expect(body.metadata.color).toBe("#3b82f6");
    expect(typeof body.metadata.updatedAt).toBe("string");

    // The row should be persisted under orgA only.
    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(eq(analyticsEventMetadataTable.eventName, eventName));
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(orgAId);
    expect(rows[0].displayName).toBe("Player Login");
  });

  it("accepts a 3-digit hex color", async () => {
    const eventName = trackEvent("t1571_short_hex");
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .put(metaUrl(orgAId, eventName))
      .send({ color: "#abc" });
    expect(res.status).toBe(200);
    expect((res.body as UpsertBody).metadata.color).toBe("#abc");
  });

  it("rejects a non-hex color with 400 and never writes the row", async () => {
    const eventName = trackEvent("t1571_bad_color");
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .put(metaUrl(orgAId, eventName))
      .send({ displayName: "Should not save", color: "red" });
    expect(res.status).toBe(400);
    expect(typeof res.body?.error).toBe("string");
    expect(String(res.body.error)).toMatch(/hex/i);

    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(eq(analyticsEventMetadataTable.eventName, eventName));
    expect(rows).toHaveLength(0);
  });

  it("rejects an event name with whitespace/garbage with 400", async () => {
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .put(metaUrl(orgAId, "bad name with spaces!"))
      .send({ displayName: "x" });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/event name/i);
  });

  it("upserts on conflict — second PUT overwrites first instead of duplicating", async () => {
    const eventName = trackEvent("t1571_upsert_evt");
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));

    const first = await request(app).put(metaUrl(orgAId, eventName))
      .send({ displayName: "First label", color: "#22c55e" });
    expect(first.status).toBe(200);
    const firstUpdatedAt = (first.body as UpsertBody).metadata.updatedAt;

    // Force a measurable delta on updated_at.
    await new Promise((r) => setTimeout(r, 25));

    const second = await request(app).put(metaUrl(orgAId, eventName))
      .send({ displayName: "Second label", color: null, description: "Updated" });
    expect(second.status).toBe(200);
    const after = (second.body as UpsertBody).metadata;
    expect(after.displayName).toBe("Second label");
    expect(after.description).toBe("Updated");
    expect(after.color).toBeNull();
    expect(new Date(after.updatedAt).getTime())
      .toBeGreaterThan(new Date(firstUpdatedAt).getTime());

    // Exactly one row should still exist for (org, event).
    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgAId),
        eq(analyticsEventMetadataTable.eventName, eventName),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Second label");
  });

  // Task #1950 — chart colors must be unique per org so the trends chart
  // and totals tiles never share a swatch between two events. The PUT
  // endpoint must reject the second event with a 409 that names the
  // conflicting event, and must NOT write the row.
  // Each Task #1950 case below uses a hex value that no other test in
  // this file ever seeds. Tests share the same orgA across the whole
  // file (one beforeAll), so picking distinct, unusual colors keeps the
  // new color-uniqueness check from cross-firing between scenarios.
  it("rejects a color already used by another event in the same org with 409 and does not write the row", async () => {
    const firstEvent = trackEvent("t1950_first_evt");
    const secondEvent = trackEvent("t1950_second_evt");
    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));

    // Seed the first event with a color no other test claims.
    await request(adminAApp).put(metaUrl(orgAId, firstEvent))
      .send({ displayName: "First Event", color: "#195001" }).expect(200);

    // Try to save the second event with the SAME color — must be blocked.
    const conflict = await request(adminAApp).put(metaUrl(orgAId, secondEvent))
      .send({ displayName: "Second Event", color: "#195001" });
    expect(conflict.status).toBe(409);
    expect(typeof conflict.body?.error).toBe("string");
    // The error message must name the conflicting event so the panel can
    // render "This color is already used by First Event".
    expect(String(conflict.body.error)).toMatch(/already used/i);
    expect(String(conflict.body.error)).toContain("First Event");
    expect(conflict.body.conflictEventName).toBe(firstEvent);

    // The blocked row must NOT have been persisted at all (not even the
    // displayName field) — the whole save is rejected.
    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgAId),
        eq(analyticsEventMetadataTable.eventName, secondEvent),
      ));
    expect(rows).toHaveLength(0);
  });

  it("treats hex color uniqueness as case-insensitive (#195002 conflicts with #195002 written as upper-case)", async () => {
    const firstEvent = trackEvent("t1950_case_first");
    const secondEvent = trackEvent("t1950_case_second");
    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));

    await request(adminAApp).put(metaUrl(orgAId, firstEvent))
      .send({ color: "#195002" }).expect(200);

    const res = await request(adminAApp).put(metaUrl(orgAId, secondEvent))
      .send({ color: "#195ABC" });
    // Sanity: those hexes differ. Now the real assertion — same color
    // in different case.
    expect(res.status).toBe(200);

    const second = await request(adminAApp).put(metaUrl(orgAId, secondEvent))
      .send({ color: "#195002".toUpperCase() });
    expect(second.status).toBe(409);
    expect(second.body.conflictEventName).toBe(firstEvent);
  });

  it("falls back to the raw event name in the error when the conflicting row has no displayName", async () => {
    const firstEvent = trackEvent("t1950_no_display_first");
    const secondEvent = trackEvent("t1950_no_display_second");
    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));

    // No displayName on the seeded row — only a color.
    await request(adminAApp).put(metaUrl(orgAId, firstEvent))
      .send({ color: "#195003" }).expect(200);

    const res = await request(adminAApp).put(metaUrl(orgAId, secondEvent))
      .send({ color: "#195003" });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain(firstEvent);
  });

  it("allows re-saving the same color on the same event (no spurious self-conflict)", async () => {
    const eventName = trackEvent("t1950_self_resave");
    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));

    await request(adminAApp).put(metaUrl(orgAId, eventName))
      .send({ displayName: "Player Login", color: "#195004" }).expect(200);

    // Saving the same row again with the same color must succeed —
    // the conflict check excludes the row being upserted.
    const res = await request(adminAApp).put(metaUrl(orgAId, eventName))
      .send({ displayName: "Player Login (renamed)", color: "#195004" });
    expect(res.status).toBe(200);
    expect((res.body as UpsertBody).metadata.color).toBe("#195004");
    expect((res.body as UpsertBody).metadata.displayName).toBe("Player Login (renamed)");
  });

  it("allows two different orgs to use the same color (uniqueness is org-scoped)", async () => {
    const evt = trackEvent("t1950_cross_org");
    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const adminBApp = createTestApp(asUser(adminBId, "org_admin", orgBId));

    await request(adminAApp).put(metaUrl(orgAId, evt))
      .send({ color: "#195005" }).expect(200);

    // The same color in a *different* org must be allowed — uniqueness
    // is per-organization, never global.
    const res = await request(adminBApp).put(metaUrl(orgBId, evt))
      .send({ color: "#195005" });
    expect(res.status).toBe(200);
    expect((res.body as UpsertBody).metadata.color).toBe("#195005");
  });

  it("super_admin can write metadata for any org", async () => {
    const eventName = trackEvent("t1571_super_evt");
    const res = await request(createTestApp(asUser(superAdminId, "super_admin", null)))
      .put(metaUrl(orgBId, eventName))
      .send({ displayName: "Super wrote this", color: "#a855f7" });
    expect(res.status).toBe(200);
    expect((res.body as UpsertBody).metadata.displayName).toBe("Super wrote this");

    const rows = await db.select().from(analyticsEventMetadataTable)
      .where(eq(analyticsEventMetadataTable.eventName, eventName));
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(orgBId);
  });
});

describe("GET /api/organizations/:orgId/analytics/events/metadata", () => {
  it("returns every override for the requesting org and only that org", async () => {
    // Seed two siblings in orgA and one in orgB to confirm tenant scoping.
    const evtA1 = trackEvent("t1571_listing_a1");
    const evtA2 = trackEvent("t1571_listing_a2");
    const evtB1 = trackEvent("t1571_listing_b1");

    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const adminBApp = createTestApp(asUser(adminBId, "org_admin", orgBId));

    // Task #1950 — colors here are deliberately unique per (org, event)
    // so the new color-uniqueness check doesn't reject the seed PUTs.
    // The listing assertion only cares about the displayName / event name
    // round-trip, not the specific color value.
    await request(adminAApp).put(metaUrl(orgAId, evtA1))
      .send({ displayName: "A One", color: "#d946ef" }).expect(200);
    await request(adminAApp).put(metaUrl(orgAId, evtA2))
      .send({ displayName: "A Two" }).expect(200);
    await request(adminBApp).put(metaUrl(orgBId, evtB1))
      .send({ displayName: "B One", color: "#ec4899" }).expect(200);

    const aRes = await request(adminAApp).get(metaUrl(orgAId));
    expect(aRes.status).toBe(200);
    const aNames = (aRes.body as ListBody).metadata.map((m) => m.eventName);
    expect(aNames).toEqual(expect.arrayContaining([evtA1, evtA2]));
    expect(aNames).not.toContain(evtB1);

    const bRes = await request(adminBApp).get(metaUrl(orgBId));
    expect(bRes.status).toBe(200);
    const bNames = (bRes.body as ListBody).metadata.map((m) => m.eventName);
    expect(bNames).toContain(evtB1);
    expect(bNames).not.toContain(evtA1);
    expect(bNames).not.toContain(evtA2);
  });
});

describe("DELETE /api/organizations/:orgId/analytics/events/metadata/:eventName", () => {
  it("removes only the (orgId, eventName) row, leaving siblings and the same event name in another org intact", async () => {
    const target = trackEvent("t1571_delete_target");
    const sibling = trackEvent("t1571_delete_sibling");

    const adminAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const adminBApp = createTestApp(asUser(adminBId, "org_admin", orgBId));

    // Seed: same `target` name in BOTH orgs (this pins the (org, event)
    // composite-key behavior — deleting in orgA must NOT touch orgB's
    // row even though the event names are identical) plus a sibling in
    // orgA so we can confirm scoping by name as well.
    await request(adminAApp).put(metaUrl(orgAId, target))
      .send({ displayName: "Target A" }).expect(200);
    await request(adminAApp).put(metaUrl(orgAId, sibling))
      .send({ displayName: "Sibling A" }).expect(200);
    await request(adminBApp).put(metaUrl(orgBId, target))
      .send({ displayName: "Target B" }).expect(200);

    const del = await request(adminAApp).delete(metaUrl(orgAId, target));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    // Target row in orgA is gone.
    const targetRows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgAId),
        eq(analyticsEventMetadataTable.eventName, target),
      ));
    expect(targetRows).toHaveLength(0);

    // Sibling in orgA survives (same org, different event name).
    const siblingRows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgAId),
        eq(analyticsEventMetadataTable.eventName, sibling),
      ));
    expect(siblingRows).toHaveLength(1);

    // Other org's row with the same event name survives — proves the
    // delete is scoped by both organizationId AND eventName, not just by
    // event name.
    const otherRows = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgBId),
        eq(analyticsEventMetadataTable.eventName, target),
      ));
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].displayName).toBe("Target B");
  });

  it("returns 400 when the event name is invalid", async () => {
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .delete(metaUrl(orgAId, "no spaces allowed"));
    expect(res.status).toBe(400);
  });

  it("returns 200 even when the (orgId, eventName) row does not exist", async () => {
    const res = await request(createTestApp(asUser(adminAId, "org_admin", orgAId)))
      .delete(metaUrl(orgAId, trackEvent("t1571_delete_missing")));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
