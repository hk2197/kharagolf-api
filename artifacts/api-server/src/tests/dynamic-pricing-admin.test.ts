/**
 * Tests for the Dynamic Pricing Admin REST surface — Task #588.
 *
 * Covers the admin endpoints in
 * `artifacts/api-server/src/routes/tee-pricing.ts` that were not exercised
 * by the engine tests in `dynamic-pricing.test.ts`:
 *
 *   - Config PUT writes `config.activated` / `config.deactivated` audit rows.
 *   - Tier CRUD (`POST`, `PATCH`, `DELETE`) and lifecycle (`activate` /
 *     `deactivate`) write the matching audit actions.
 *   - Modifier CRUD writes `modifier.created` / `modifier.updated` /
 *     `modifier.deleted` audit rows.
 *   - `POST /preview` and `POST /preview-calendar` return sensible
 *     price breakdowns over a date/time grid.
 *   - `GET /yield-report` summarises seeded bookings + a baseline
 *     legacy rate into plausible `revenue`, `baseline_revenue`, and
 *     `uplift_pct` numbers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  teePricingRulesTable,
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
  teeDynamicPricingAuditTable,
  teePricingForecastsTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

function nextDateForDow(targetDow: number, minDaysAhead = 7): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
  return d;
}

async function clearDynamic() {
  await db.delete(teeDynamicPricingAuditTable).where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
}

// The publish endpoints kick off forecast persistence as a fire-and-forget
// background task so the HTTP response isn't blocked on it. Tests need to
// poll briefly for the row to land instead of asserting synchronously.
async function waitForForecast(label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.select().from(teePricingForecastsTable)
      .where(and(
        eq(teePricingForecastsTable.organizationId, orgId),
        eq(teePricingForecastsTable.label, label),
      ));
    if (rows.length > 0) return rows;
    await new Promise(r => setTimeout(r, 50));
  }
  return [];
}

async function latestAudit(action: string) {
  const rows = await db.select().from(teeDynamicPricingAuditTable)
    .where(and(
      eq(teeDynamicPricingAuditTable.organizationId, orgId),
      eq(teeDynamicPricingAuditTable.action, action),
    ))
    .orderBy(desc(teeDynamicPricingAuditTable.createdAt))
    .limit(1);
  return rows[0];
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `DynPricingAdminTest_${stamp}`,
    slug: `dyn-pricing-admin-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `dyn-pricing-admin-${stamp}`,
    username: `dyn_pricing_admin_${stamp}`,
    email: `dyn_pricing_admin_${stamp}@example.com`,
    displayName: "Dyn Pricing Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Admin Test Course",
    slug: `admin-test-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId,
    memberRate: "1000",
    guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `dyn_pricing_admin_${stamp}`,
    displayName: "Dyn Pricing Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (orgId) {
    // Drop any leftover bookings (and their player rows via FK cascade)
    // before removing slots, then let the org cascade clean up everything else.
    const leftover = await db.select({ id: teeBookingsTable.id })
      .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    for (const b of leftover) {
      await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
    }
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

// ─── CONFIG audit ────────────────────────────────────────────────────────────

describe("PUT /tee-pricing/config — audit", () => {
  it("writes config.activated when toggling enabled from false to true", async () => {
    await clearDynamic();
    // Seed a disabled config so the route sees a previous row with enabled=false.
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: false,
      priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: false, updatedAt: new Date() },
    });

    const res = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: true, priceFloorPct: "0.60", priceCeilingPct: "1.80", dealBadgeThresholdPct: "0.85" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.enabled).toBe(true);

    const audit = await latestAudit("config.activated");
    expect(audit, "expected a config.activated audit row").toBeDefined();
    expect(audit.entityType).toBe("config");
    expect(audit.actorUserId).toBe(userId);
  });

  it("writes config.deactivated when toggling enabled from true to false", async () => {
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: true,
      priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: true, updatedAt: new Date() },
    });

    const res = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: false });
    expect(res.status, res.text).toBe(200);
    expect(res.body.enabled).toBe(false);

    const audit = await latestAudit("config.deactivated");
    expect(audit).toBeDefined();
    expect(audit.entityType).toBe("config");
  });

  it("persists per-segment default elasticities through PUT and returns them from GET", async () => {
    await clearDynamic();
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: false,
      priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: false, updatedAt: new Date() },
    });

    // PUT custom member + guest elasticities and confirm the response echoes them.
    const putRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: false, defaultMemberElasticity: -0.3, defaultGuestElasticity: -0.8 });
    expect(putRes.status, putRes.text).toBe(200);
    expect(parseFloat(putRes.body.defaultMemberElasticity)).toBeCloseTo(-0.3, 2);
    expect(parseFloat(putRes.body.defaultGuestElasticity)).toBeCloseTo(-0.8, 2);

    // GET should return the same persisted values.
    const getRes = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/config`);
    expect(getRes.status, getRes.text).toBe(200);
    expect(parseFloat(getRes.body.defaultMemberElasticity)).toBeCloseTo(-0.3, 2);
    expect(parseFloat(getRes.body.defaultGuestElasticity)).toBeCloseTo(-0.8, 2);

    // Out-of-range values are clamped to the supported band [-3, 0] for both segments.
    const clampRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: false, defaultMemberElasticity: -99, defaultGuestElasticity: 5 });
    expect(clampRes.status, clampRes.text).toBe(200);
    expect(parseFloat(clampRes.body.defaultMemberElasticity)).toBeCloseTo(-3, 2);
    expect(parseFloat(clampRes.body.defaultGuestElasticity)).toBeCloseTo(0, 2);

    // Omitting both fields on PUT preserves the previously saved values.
    const preserveRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: true });
    expect(preserveRes.status, preserveRes.text).toBe(200);
    expect(parseFloat(preserveRes.body.defaultMemberElasticity)).toBeCloseTo(-3, 2);
    expect(parseFloat(preserveRes.body.defaultGuestElasticity)).toBeCloseTo(0, 2);

    // Updating only one segment preserves the other.
    const partialRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/config`)
      .send({ enabled: true, defaultMemberElasticity: -0.15 });
    expect(partialRes.status, partialRes.text).toBe(200);
    expect(parseFloat(partialRes.body.defaultMemberElasticity)).toBeCloseTo(-0.15, 2);
    expect(parseFloat(partialRes.body.defaultGuestElasticity)).toBeCloseTo(0, 2);
  });
});

// ─── TIER CRUD audit ─────────────────────────────────────────────────────────

describe("Tier CRUD — audit log", () => {
  it("creates, updates, deactivates, activates, and deletes a tier with audit rows", async () => {
    await clearDynamic();

    // CREATE
    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers`)
      .send({
        name: "Twilight",
        daysOfWeek: [5, 6],
        startTime: "16:00",
        endTime: "20:00",
        memberType: "any",
        memberRate: 700,
        guestRate: 1100,
        priority: 3,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const tierId: number = createRes.body.id;
    expect(tierId).toBeGreaterThan(0);
    expect(createRes.body.name).toBe("Twilight");
    expect(createRes.body.priority).toBe(3);

    const created = await latestAudit("tier.created");
    expect(created).toBeDefined();
    expect(created.entityType).toBe("tier");
    expect(created.entityId).toBe(tierId);

    // UPDATE
    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`)
      .send({ memberRate: 850, priority: 7 });
    expect(patchRes.status, patchRes.text).toBe(200);
    expect(parseFloat(String(patchRes.body.memberRate))).toBe(850);
    expect(patchRes.body.priority).toBe(7);

    const updated = await latestAudit("tier.updated");
    expect(updated).toBeDefined();
    expect(updated.entityId).toBe(tierId);
    const patchPayload = updated.payload as { previous: { memberRate: string }; next: { memberRate: string } };
    expect(parseFloat(String(patchPayload.previous.memberRate))).toBe(700);
    expect(parseFloat(String(patchPayload.next.memberRate))).toBe(850);

    // DEACTIVATE (rollback)
    const deactivateRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/deactivate`)
      .send({ notes: "Test rollback" });
    expect(deactivateRes.status, deactivateRes.text).toBe(200);
    expect(deactivateRes.body.isActive).toBe(false);

    const deactivated = await latestAudit("tier.deactivated");
    expect(deactivated).toBeDefined();
    expect(deactivated.entityId).toBe(tierId);
    expect(deactivated.notes).toBe("Test rollback");

    // ACTIVATE
    const activateRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/activate`)
      .send({});
    expect(activateRes.status, activateRes.text).toBe(200);
    expect(activateRes.body.isActive).toBe(true);

    const activated = await latestAudit("tier.activated");
    expect(activated).toBeDefined();
    expect(activated.entityId).toBe(tierId);

    // LIST
    const listRes = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/tiers`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.find((t: { id: number }) => t.id === tierId)).toBeDefined();

    // DELETE
    const delRes = await request(app)
      .delete(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`);
    expect(delRes.status, delRes.text).toBe(200);
    expect(delRes.body.success).toBe(true);

    const deleted = await latestAudit("tier.deleted");
    expect(deleted).toBeDefined();
    expect(deleted.entityId).toBe(tierId);
  });

  it("records a forecast snapshot labelled `publish:tier-<id>` when a tier is activated or deactivated (Task #954)", async () => {
    await clearDynamic();

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers`)
      .send({
        name: "PublishSnapshot",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        memberRate: 500,
        guestRate: 900,
        priority: 1,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const tierId: number = createRes.body.id;
    const expectedLabel = `publish:tier-${tierId}`;

    // Activating the tier must trigger a persisted forecast snapshot
    // tagged with the publish label, so accuracy can be scored later.
    const activateRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/activate`)
      .send({});
    expect(activateRes.status, activateRes.text).toBe(200);

    const afterActivate = await waitForForecast(expectedLabel);
    expect(afterActivate.length).toBeGreaterThanOrEqual(2);
    const scenarios = new Set(afterActivate.map(r => r.scenario));
    expect(scenarios.has("active")).toBe(true);
    expect(scenarios.has("draft")).toBe(true);
    for (const row of afterActivate) {
      expect(row.label).toBe(expectedLabel);
      expect(row.organizationId).toBe(orgId);
    }

    // Deactivating should add another snapshot pair under the same label.
    const beforeCount = afterActivate.length;
    const deactivateRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/deactivate`)
      .send({});
    expect(deactivateRes.status, deactivateRes.text).toBe(200);

    const deadline = Date.now() + 5000;
    let afterDeactivate = afterActivate;
    while (Date.now() < deadline) {
      afterDeactivate = await waitForForecast(expectedLabel);
      if (afterDeactivate.length > beforeCount) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(afterDeactivate.length).toBeGreaterThan(beforeCount);

    // Cleanup so the surrounding tier CRUD test stays independent.
    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`);
  });

  it("exposes the most recent publish:tier-<id> snapshot per tier via GET /tiers/publish-snapshots (Task #1103)", async () => {
    await clearDynamic();

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers`)
      .send({
        name: "PublishSnapshotBadge",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        memberRate: 600,
        guestRate: 1100,
        priority: 1,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const tierId: number = createRes.body.id;
    const expectedLabel = `publish:tier-${tierId}`;

    // Activate twice to seed two snapshot pairs; the endpoint should
    // surface only the most recent active row.
    await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/activate`)
      .send({});
    await waitForForecast(expectedLabel);
    await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/deactivate`)
      .send({});
    // Wait for at least one more pair to land.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const all = await db.select().from(teePricingForecastsTable)
        .where(and(
          eq(teePricingForecastsTable.organizationId, orgId),
          eq(teePricingForecastsTable.label, expectedLabel),
        ));
      if (all.length >= 4) break;
      await new Promise(r => setTimeout(r, 50));
    }

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/tiers/publish-snapshots`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.snapshots).toBeDefined();
    const snap = res.body.snapshots[String(tierId)];
    expect(snap, "expected a snapshot for the tier").toBeDefined();
    expect(snap.label).toBe(expectedLabel);
    expect(snap.scenario).toBe("active");
    expect(typeof snap.projectedRevenue).toBe("number");
    expect(typeof snap.horizonDays).toBe("number");
    expect(typeof snap.windowStart).toBe("string");
    expect(typeof snap.windowEnd).toBe("string");
    expect(snap.tierId).toBe(tierId);

    // The returned row must be the most recent active snapshot for this label.
    const rows = await db.select().from(teePricingForecastsTable)
      .where(and(
        eq(teePricingForecastsTable.organizationId, orgId),
        eq(teePricingForecastsTable.label, expectedLabel),
        eq(teePricingForecastsTable.scenario, "active"),
      ))
      .orderBy(desc(teePricingForecastsTable.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const newest = rows[0];
    const newestIso = newest.createdAt instanceof Date
      ? newest.createdAt.toISOString()
      : String(newest.createdAt);
    expect(snap.createdAt).toBe(newestIso);

    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`);
  });

  it("records a forecast snapshot labelled `publish:modifier-<id>` when an active modifier is created or updated (Task #954)", async () => {
    await clearDynamic();

    // Creating an ACTIVE modifier is a publish event → snapshot expected.
    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers`)
      .send({
        name: "PublishModifier",
        kind: "utilization",
        thresholdMin: 0.8,
        adjustmentType: "percent",
        adjustmentValue: 0.10,
        isActive: true,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const modId: number = createRes.body.id;
    const expectedLabel = `publish:modifier-${modId}`;

    const afterCreate = await waitForForecast(expectedLabel);
    expect(afterCreate.length).toBeGreaterThanOrEqual(2);
    const scenarios = new Set(afterCreate.map(r => r.scenario));
    expect(scenarios.has("active")).toBe(true);
    expect(scenarios.has("draft")).toBe(true);

    // Patching an active modifier should also trigger another snapshot.
    const beforeCount = afterCreate.length;
    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`)
      .send({ adjustmentValue: 0.15 });
    expect(patchRes.status, patchRes.text).toBe(200);

    const deadline = Date.now() + 5000;
    let afterPatch = afterCreate;
    while (Date.now() < deadline) {
      afterPatch = await waitForForecast(expectedLabel);
      if (afterPatch.length > beforeCount) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(afterPatch.length).toBeGreaterThan(beforeCount);

    // Cleanup.
    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`);
  });

  it("exposes the most recent publish:modifier-<id> snapshot per modifier via GET /modifiers/publish-snapshots (Task #1257)", async () => {
    await clearDynamic();

    // Creating an active modifier triggers a publish snapshot. Patching it
    // again triggers a second one, so we can later assert the endpoint
    // returns the most-recent active row.
    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers`)
      .send({
        name: "PublishModifierBadge",
        kind: "utilization",
        thresholdMin: 0.7,
        adjustmentType: "percent",
        adjustmentValue: 0.10,
        isActive: true,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const modId: number = createRes.body.id;
    const expectedLabel = `publish:modifier-${modId}`;

    await waitForForecast(expectedLabel);
    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`)
      .send({ adjustmentValue: 0.15 });
    expect(patchRes.status, patchRes.text).toBe(200);

    // Wait for at least two active+draft pairs to land (4 rows total).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const all = await db.select().from(teePricingForecastsTable)
        .where(and(
          eq(teePricingForecastsTable.organizationId, orgId),
          eq(teePricingForecastsTable.label, expectedLabel),
        ));
      if (all.length >= 4) break;
      await new Promise(r => setTimeout(r, 50));
    }

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/modifiers/publish-snapshots`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.snapshots).toBeDefined();
    const snap = res.body.snapshots[String(modId)];
    expect(snap, "expected a snapshot for the modifier").toBeDefined();
    expect(snap.label).toBe(expectedLabel);
    expect(snap.scenario).toBe("active");
    expect(typeof snap.projectedRevenue).toBe("number");
    expect(typeof snap.horizonDays).toBe("number");
    expect(typeof snap.windowStart).toBe("string");
    expect(typeof snap.windowEnd).toBe("string");
    expect(snap.modifierId).toBe(modId);

    // The returned row must be the most recent active snapshot for this label.
    const rows = await db.select().from(teePricingForecastsTable)
      .where(and(
        eq(teePricingForecastsTable.organizationId, orgId),
        eq(teePricingForecastsTable.label, expectedLabel),
        eq(teePricingForecastsTable.scenario, "active"),
      ))
      .orderBy(desc(teePricingForecastsTable.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const newest = rows[0];
    const newestIso = newest.createdAt instanceof Date
      ? newest.createdAt.toISOString()
      : String(newest.createdAt);
    expect(snap.createdAt).toBe(newestIso);

    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`);
  });

  it("does not record a forecast snapshot when an inactive (draft) modifier is created (Task #954)", async () => {
    await clearDynamic();

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers`)
      .send({
        name: "DraftModifier",
        kind: "utilization",
        thresholdMin: 0.5,
        adjustmentType: "percent",
        adjustmentValue: 0.05,
        isActive: false,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const modId: number = createRes.body.id;
    const expectedLabel = `publish:modifier-${modId}`;

    // Wait a moment to be sure no fire-and-forget snapshot lands.
    await new Promise(r => setTimeout(r, 800));
    const rows = await db.select().from(teePricingForecastsTable)
      .where(and(
        eq(teePricingForecastsTable.organizationId, orgId),
        eq(teePricingForecastsTable.label, expectedLabel),
      ));
    expect(rows.length).toBe(0);

    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`);
  });

  it("returns 400 when creating a tier without a name", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers`)
      .send({ memberRate: 100 });
    expect(res.status).toBe(400);
  });

  it("returns 404 when patching a non-existent tier", async () => {
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/tiers/999999999`)
      .send({ memberRate: 1 });
    expect(res.status).toBe(404);
  });
});

// ─── MODIFIER CRUD audit ─────────────────────────────────────────────────────

describe("Modifier CRUD — audit log", () => {
  it("creates, updates, and deletes a modifier with audit rows", async () => {
    await clearDynamic();

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers`)
      .send({
        name: "Peak surge",
        kind: "utilization",
        thresholdMin: 0.8,
        thresholdMax: 1.01,
        adjustmentType: "percent",
        adjustmentValue: 15,
        applyTo: "any",
        priority: 2,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const modId: number = createRes.body.id;
    expect(modId).toBeGreaterThan(0);

    const created = await latestAudit("modifier.created");
    expect(created).toBeDefined();
    expect(created.entityType).toBe("modifier");
    expect(created.entityId).toBe(modId);

    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`)
      .send({ adjustmentValue: 25 });
    expect(patchRes.status, patchRes.text).toBe(200);
    expect(parseFloat(String(patchRes.body.adjustmentValue))).toBe(25);

    const updated = await latestAudit("modifier.updated");
    expect(updated).toBeDefined();
    expect(updated.entityId).toBe(modId);

    const listRes = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/modifiers`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((m: { id: number }) => m.id === modId)).toBeDefined();

    const delRes = await request(app)
      .delete(`/api/organizations/${orgId}/tee-pricing/modifiers/${modId}`);
    expect(delRes.status).toBe(200);

    const deleted = await latestAudit("modifier.deleted");
    expect(deleted).toBeDefined();
    expect(deleted.entityId).toBe(modId);
  });

  it("returns 400 when creating a modifier without name/kind", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers`)
      .send({ name: "no kind" });
    expect(res.status).toBe(400);
  });
});

// ─── PREVIEW endpoints ───────────────────────────────────────────────────────

describe("POST /tee-pricing/preview", () => {
  it("returns a sane price breakdown for a slot when a tier matches", async () => {
    await clearDynamic();
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: true,
      priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: true, updatedAt: new Date() },
    });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Preview tier",
      daysOfWeek: [0,1,2,3,4,5,6],
      memberType: "any", memberRate: "900", guestRate: "1300", priority: 5,
    });

    const slotDate = nextDateForDow(3);
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/preview`)
      .send({
        courseId,
        slotDate: slotDate.toISOString(),
        slotTime: "10:00",
        capacity: 4,
        bookedCount: 0,
        memberType: "member",
      });
    expect(res.status, res.text).toBe(200);
    // basePrice tracks the legacy fallback rate; the tier replaces finalPrice.
    expect(res.body.basePrice).toBe(1000);
    expect(res.body.finalPrice).toBe(900);
    expect(res.body.tierName).toBe("Preview tier");
    expect(Array.isArray(res.body.breakdown)).toBe(true);
    expect(res.body.breakdown.length).toBeGreaterThan(0);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/preview`)
      .send({ courseId });
    expect(res.status).toBe(400);
  });
});

describe("POST /tee-pricing/preview-calendar", () => {
  it("returns a date × time grid of resolved prices", async () => {
    await clearDynamic();
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: true,
      priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: true, updatedAt: new Date() },
    });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Cal tier",
      daysOfWeek: [0,1,2,3,4,5,6],
      memberType: "any", memberRate: "950", guestRate: "1450", priority: 5,
    });

    const start = nextDateForDow(1); // Monday
    const end = new Date(start);
    end.setDate(end.getDate() + 2); // 3-day window
    const fromDate = start.toISOString().split("T")[0];
    const toDate = end.toISOString().split("T")[0];

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/preview-calendar`)
      .send({
        courseId,
        fromDate,
        toDate,
        times: ["08:00", "12:00", "16:00"],
        memberType: "member",
      });
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body.calendar)).toBe(true);
    expect(res.body.calendar.length).toBe(3);
    for (const day of res.body.calendar) {
      expect(typeof day.date).toBe("string");
      expect(day.rows.length).toBe(3);
      for (const row of day.rows) {
        expect(row.price).toBe(950);
        // basePrice tracks the legacy fallback rate, not the tier rate.
        expect(row.basePrice).toBe(1000);
        expect(row.tierName).toBe("Cal tier");
        expect(typeof row.isDeal).toBe("boolean");
      }
    }
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/preview-calendar`)
      .send({ courseId, fromDate: "2026-01-01" });
    expect(res.status).toBe(400);
  });
});

// ─── YIELD REPORT ────────────────────────────────────────────────────────────

describe("GET /tee-pricing/yield-report", () => {
  it("summarises seeded bookings against the legacy baseline", async () => {
    // Use a recent past window so bookings/slots fall inside it.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 5);
    const toDate = new Date(today);
    const fromStr = fromDate.toISOString().split("T")[0];
    const toStr = toDate.toISOString().split("T")[0];

    // Clean any prior bookings for this org.
    const priorBookings = await db.select({ id: teeBookingsTable.id })
      .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    for (const b of priorBookings) {
      await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
    }
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));

    // Seed two slots in the window with confirmed bookings.
    // Each slot: capacity 4, a confirmed booking of party_size 2.
    // Effective per-seat price: 1200 (above the 1000 baseline) → uplift is positive.
    const day1 = new Date(fromDate); day1.setDate(day1.getDate() + 1);
    const day2 = new Date(fromDate); day2.setDate(day2.getDate() + 2);

    const [s1] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: day1, slotTime: "09:00", capacity: 4,
    }).returning();
    const [s2] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: day2, slotTime: "10:00", capacity: 4,
    }).returning();

    const [b1] = await db.insert(teeBookingsTable).values({
      slotId: s1.id, organizationId: orgId, leadUserId: userId,
      partySize: 2, status: "confirmed",
      totalAmount: "2400", currency: "INR",
    }).returning();
    const [b2] = await db.insert(teeBookingsTable).values({
      slotId: s2.id, organizationId: orgId, leadUserId: userId,
      partySize: 2, status: "completed",
      totalAmount: "2400", currency: "INR",
    }).returning();

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/yield-report`)
      .query({ fromDate: fromStr, toDate: toStr });
    expect(res.status, res.text).toBe(200);

    const summary = res.body.summary;
    expect(summary).toBeDefined();
    // 2 bookings × 2400 = 4800
    expect(Number(summary.revenue)).toBeCloseTo(4800, 2);
    // 4 seats booked total
    expect(Number(summary.seats_booked)).toBe(4);
    // 2 slots × capacity 4 = 8 seats total in the window
    expect(Number(summary.seats_total)).toBe(8);
    // Baseline: 4 seats × 1000 legacy member rate = 4000
    expect(Number(summary.baseline_revenue)).toBeCloseTo(4000, 2);
    // Uplift: (4800 - 4000) / 4000 = +20%
    expect(Number(summary.uplift_revenue)).toBeCloseTo(800, 2);
    expect(Number(summary.uplift_pct)).toBeCloseTo(20, 1);

    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.daily.length).toBeGreaterThan(0);
    const dailyRevenue = res.body.daily.reduce(
      (acc: number, d: { revenue: number }) => acc + Number(d.revenue), 0,
    );
    expect(dailyRevenue).toBeCloseTo(4800, 2);

    expect(Array.isArray(res.body.byTier)).toBe(true);

    // Cleanup
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b1.id));
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b2.id));
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.id, b1.id));
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.id, b2.id));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.id, s1.id));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.id, s2.id));
  });

  it("returns 400 when fromDate/toDate are missing", async () => {
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/yield-report`);
    expect(res.status).toBe(400);
  });
});
