/**
 * Task #1023 — Integration test for the "Apply & activate" sequence
 * triggered from the tier editor's what-if forecast panel
 * (artifacts/kharagolf-web/src/pages/dynamic-pricing.tsx → applyAndActivateDraft).
 *
 * The web button issues two requests in order against the same tier id:
 *   1. PATCH /organizations/:orgId/tee-pricing/tiers/:id  — saves the draft
 *   2. POST  /organizations/:orgId/tee-pricing/tiers/:id/activate — flips it live
 *
 * This test exercises that exact sequence end-to-end against the real
 * Express router + database and asserts:
 *   - The PATCH applies the edited fields (memberRate, name).
 *   - The POST /activate returns isActive=true.
 *   - The activate endpoint writes a `tier.activated` audit row pointing at
 *     the same tier id, with the same actor, matching the manual toggle.
 *   - A `tier.updated` audit row from the PATCH precedes it (so the audit
 *     trail captures both halves of the apply-and-activate action).
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
  teeDynamicPricingAuditTable,
  teePricingForecastsTable,
} from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

async function clearDynamic() {
  await db.delete(teeDynamicPricingAuditTable).where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ApplyActivateTest_${stamp}`,
    slug: `apply-activate-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `apply-activate-${stamp}`,
    username: `apply_activate_${stamp}`,
    email: `apply_activate_${stamp}@example.com`,
    displayName: "Apply Activate Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });

  await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Apply Activate Course",
    slug: `apply-activate-course-${stamp}`,
  });

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId,
    memberRate: "1000",
    guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `apply_activate_${stamp}`,
    displayName: "Apply Activate Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (orgId) {
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

describe("Dynamic Pricing — Apply & activate sequence (Task #1023)", () => {
  it("PATCH+activate flips a draft tier live and writes a tier.activated audit row", async () => {
    await clearDynamic();

    // Seed an inactive draft tier — this is the state the editor opens
    // when an admin clicks the pencil on a draft.
    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers`)
      .send({
        name: "Twilight draft",
        daysOfWeek: [5, 6],
        memberRate: 700,
        guestRate: 1100,
        priority: 3,
        isActive: false,
      });
    expect(createRes.status, createRes.text).toBe(201);
    const tierId: number = createRes.body.id;
    expect(createRes.body.isActive).toBe(false);

    // Step 1: editor PATCHes the draft with edited fields (memberRate bump).
    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`)
      .send({ name: "Twilight draft", memberRate: 850, isActive: false });
    expect(patchRes.status, patchRes.text).toBe(200);
    expect(parseFloat(String(patchRes.body.memberRate))).toBe(850);
    // PATCH alone must not flip the tier live — that's the activate endpoint's job.
    expect(patchRes.body.isActive).toBe(false);

    // Step 2: editor POSTs to /activate — same endpoint as the manual toggle.
    const activateRes = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}/activate`)
      .send({});
    expect(activateRes.status, activateRes.text).toBe(200);
    expect(activateRes.body.isActive).toBe(true);
    expect(activateRes.body.id).toBe(tierId);

    // Persisted state now matches: the row is live in the DB.
    const [persisted] = await db.select().from(teeDynamicPricingTiersTable)
      .where(and(
        eq(teeDynamicPricingTiersTable.organizationId, orgId),
        eq(teeDynamicPricingTiersTable.id, tierId),
      ));
    expect(persisted.isActive).toBe(true);
    expect(parseFloat(String(persisted.memberRate))).toBe(850);

    // Audit trail: both the update and the activation are recorded, in
    // chronological order, and both point at the same tier and actor.
    const auditRows = await db.select().from(teeDynamicPricingAuditTable)
      .where(and(
        eq(teeDynamicPricingAuditTable.organizationId, orgId),
        eq(teeDynamicPricingAuditTable.entityType, "tier"),
        eq(teeDynamicPricingAuditTable.entityId, tierId),
      ))
      .orderBy(asc(teeDynamicPricingAuditTable.createdAt), asc(teeDynamicPricingAuditTable.id));

    const actions = auditRows.map(r => r.action);
    expect(actions).toContain("tier.updated");
    expect(actions).toContain("tier.activated");

    const updatedIdx = actions.indexOf("tier.updated");
    const activatedIdx = actions.indexOf("tier.activated");
    expect(activatedIdx).toBeGreaterThan(updatedIdx);

    const activated = auditRows[activatedIdx];
    expect(activated.entityId).toBe(tierId);
    expect(activated.actorUserId).toBe(userId);
    // The audit payload is the tier row at activation time — confirm it
    // carries the freshly-PATCHed memberRate so the audit reflects the
    // exact state that went live.
    const payload = activated.payload as { memberRate: string; isActive: boolean };
    expect(parseFloat(String(payload.memberRate))).toBe(850);
    expect(payload.isActive).toBe(true);

    // Cleanup so a follow-up run isn't tripped by leftovers.
    await request(app).delete(`/api/organizations/${orgId}/tee-pricing/tiers/${tierId}`);
  });
});
