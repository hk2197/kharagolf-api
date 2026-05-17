/**
 * Integration tests for the post-round summary mobile sponsor banner ad
 * slot (Task #886): `mobile_round_summary`.
 *
 * Coverage:
 *   - GET /api/organizations/:orgId/ad-inventory/slots auto-seeds the
 *     `mobile_round_summary` slot for a brand-new org with the expected
 *     surface ("mobile") and rotation defaults (15s).
 *   - POST /api/public/sponsor-events records impressions/clicks against
 *     this slot key with full attribution, and
 *     GET /api/organizations/:orgId/ad-inventory/slots/:slotId/metrics
 *     rolls them up under the new slot.
 *   - The per-campaign metrics endpoint reports the same totals.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  sponsorsTable,
  sponsorEventsTable,
  adSlotsTable,
  adCreativesTable,
  adCampaignsTable,
  tournamentsTable,
  coursesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let orgId: number;
let adminUserId: number;
let admin: TestUser;
let sponsorId: number;
let courseId: number;
let tournamentId: number;

const SUMMARY = "mobile_round_summary";

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_RoundSummaryAd_${stamp}`,
    slug: `test-rsumads-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `rsumads-admin-${stamp}`,
    username: `rsumads_admin_${stamp}`,
    email: `rsumads_admin_${stamp}@example.com`,
    displayName: "Org Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = u.id;
  admin = { id: adminUserId, username: `rsumads_admin_${stamp}`, role: "org_admin", organizationId: orgId };

  const [sp] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name: `Round Summary Sponsor ${stamp}`,
    tier: "gold",
  }).returning({ id: sponsorsTable.id });
  sponsorId = sp.id;

  const [c] = await db.insert(coursesTable).values({
    name: `Course RSumAds ${stamp}`,
    slug: `course-rsumads-${stamp}`,
    organizationId: orgId,
    holes: 18,
  }).returning({ id: coursesTable.id });
  courseId = c.id;

  const [t] = await db.insert(tournamentsTable).values({
    name: `Tournament RSumAds ${stamp}`,
    organizationId: orgId,
    courseId,
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 86_400_000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;
});

afterAll(async () => {
  await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.organizationId, orgId));
  await db.delete(adCampaignsTable).where(eq(adCampaignsTable.organizationId, orgId));
  await db.delete(adCreativesTable).where(eq(adCreativesTable.organizationId, orgId));
  await db.delete(adSlotsTable).where(eq(adSlotsTable.organizationId, orgId));
  await db.delete(sponsorsTable).where(eq(sponsorsTable.organizationId, orgId));
  if (tournamentId) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function getSlotByKey(slotKey: string) {
  const [row] = await db.select({
    id: adSlotsTable.id,
    slotKey: adSlotsTable.slotKey,
    name: adSlotsTable.name,
    surface: adSlotsTable.surface,
    rotationSeconds: adSlotsTable.rotationSeconds,
    isActive: adSlotsTable.isActive,
  })
    .from(adSlotsTable)
    .where(and(eq(adSlotsTable.organizationId, orgId), eq(adSlotsTable.slotKey, slotKey)));
  return row;
}

describe("mobile_round_summary slot seeding", () => {
  it("auto-seeds mobile_round_summary on first admin load with the expected defaults", async () => {
    // Pre-condition: brand-new org has no ad slots yet.
    const existing = await db.select().from(adSlotsTable).where(eq(adSlotsTable.organizationId, orgId));
    expect(existing).toHaveLength(0);

    const app = createTestApp(admin);
    const r = await request(app).get(`/api/organizations/${orgId}/ad-inventory/slots`);
    expect(r.status).toBe(200);

    const slotsByKey = new Map<string, { name: string; surface: string; rotationSeconds: number; isActive: boolean }>();
    for (const s of r.body as Array<{ slotKey: string; name: string; surface: string; rotationSeconds: number; isActive: boolean }>) {
      slotsByKey.set(s.slotKey, s);
    }

    const summary = slotsByKey.get(SUMMARY);
    expect(summary, "mobile_round_summary should be seeded").toBeDefined();
    expect(summary!.surface).toBe("mobile");
    expect(summary!.rotationSeconds).toBe(15);
    expect(summary!.isActive).toBe(true);

    // Idempotent: a second load must not duplicate the row.
    const r2 = await request(app).get(`/api/organizations/${orgId}/ad-inventory/slots`);
    expect(r2.status).toBe(200);
    const summaryCount = (r2.body as Array<{ slotKey: string }>).filter(s => s.slotKey === SUMMARY).length;
    expect(summaryCount).toBe(1);
  });
});

describe("mobile_round_summary event roll-up", () => {
  it("records and rolls up impressions/clicks under the mobile_round_summary slot key", async () => {
    const slot = await getSlotByKey(SUMMARY);
    expect(slot).toBeDefined();

    const [creative] = await db.insert(adCreativesTable).values({
      organizationId: orgId,
      sponsorId,
      name: "Round Summary Rollup Creative",
      mediaType: "image",
      mediaUrl: "https://cdn.example/round-summary-banner.png",
      clickThroughUrl: "https://sponsor.example/round-summary",
    }).returning({ id: adCreativesTable.id });
    const creativeId = creative.id;

    const [campaign] = await db.insert(adCampaignsTable).values({
      organizationId: orgId,
      sponsorId,
      slotId: slot!.id,
      creativeId,
      tournamentId,
      name: "Round Summary Rollup Campaign",
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 7 * 86_400_000),
      weight: 50,
      frequencyCapPerSession: 0,
    }).returning({ id: adCampaignsTable.id });
    const campaignId = campaign.id;

    const app = createTestApp();

    async function postEvent(eventType: "impression" | "click", sessionId: string) {
      const r = await request(app).post("/api/public/sponsor-events").send({
        sponsorId,
        eventType,
        source: SUMMARY,
        sessionId,
        slotKey: SUMMARY,
        campaignId,
        creativeId,
      });
      expect(r.status, `${eventType} status`).toBe(200);
      expect(r.body.ok, `${eventType} body`).toBe(true);
    }

    // 4 impressions + 2 clicks. Distinct sessions so the per-source click
    // rate-limit doesn't drop events.
    for (let i = 0; i < 4; i++) {
      await postEvent("impression", `summary-i-${i}-${stamp}`);
    }
    for (let i = 0; i < 2; i++) {
      await postEvent("click", `summary-c-${i}-${stamp}`);
    }

    // Per-row attribution lands in the events table under the new slot key.
    const persisted = await db.select({
      slotKey: sponsorEventsTable.slotKey,
      eventType: sponsorEventsTable.eventType,
      campaignId: sponsorEventsTable.campaignId,
      creativeId: sponsorEventsTable.creativeId,
    })
      .from(sponsorEventsTable)
      .where(and(
        eq(sponsorEventsTable.organizationId, orgId),
        eq(sponsorEventsTable.slotKey, SUMMARY),
      ));
    expect(persisted.filter(r => r.eventType === "impression")).toHaveLength(4);
    expect(persisted.filter(r => r.eventType === "click")).toHaveLength(2);
    expect(persisted.every(r => r.campaignId === campaignId && r.creativeId === creativeId)).toBe(true);

    // Per-slot admin metrics roll up under the mobile_round_summary slot.
    const adminApp = createTestApp(admin);
    const slotMetricsRes = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/slots/${slot!.id}/metrics`,
    );
    expect(slotMetricsRes.status).toBe(200);
    const mine = (slotMetricsRes.body as Array<{ sponsorId: number; eventType: string; total: number }>)
      .filter(m => m.sponsorId === sponsorId);
    expect(mine.find(m => m.eventType === "impression")?.total).toBe(4);
    expect(mine.find(m => m.eventType === "click")?.total).toBe(2);

    // Per-campaign metrics endpoint reports matching totals + CTR.
    const campMetrics = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/campaigns/${campaignId}/metrics`,
    );
    expect(campMetrics.status).toBe(200);
    expect(campMetrics.body.impressions).toBe(4);
    expect(campMetrics.body.clicks).toBe(2);
    expect(campMetrics.body.ctr).toBe(50);

    // Cleanup so other tests in the file (or future additions) start clean.
    await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.campaignId, campaignId));
    await db.delete(adCampaignsTable).where(eq(adCampaignsTable.id, campaignId));
    await db.delete(adCreativesTable).where(eq(adCreativesTable.id, creativeId));
  });

  it("rejects an event whose slotKey says mobile_round_summary but whose campaign belongs to another slot", async () => {
    const summarySlot = await getSlotByKey(SUMMARY);
    expect(summarySlot).toBeDefined();

    // Create a campaign on a *different* slot (mobile_scorecard_banner) and
    // try to attribute it under mobile_round_summary.
    const [otherSlot] = await db.select({ id: adSlotsTable.id }).from(adSlotsTable)
      .where(and(eq(adSlotsTable.organizationId, orgId), eq(adSlotsTable.slotKey, "mobile_scorecard_banner")));
    expect(otherSlot).toBeDefined();

    const [creative] = await db.insert(adCreativesTable).values({
      organizationId: orgId,
      sponsorId,
      name: "Mismatch Creative",
      mediaType: "image",
      mediaUrl: "https://cdn.example/mismatch.png",
    }).returning({ id: adCreativesTable.id });

    const [campaign] = await db.insert(adCampaignsTable).values({
      organizationId: orgId,
      sponsorId,
      slotId: otherSlot!.id,
      creativeId: creative.id,
      name: "Mismatch Campaign",
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(Date.now() + 7 * 86_400_000),
      weight: 10,
    }).returning({ id: adCampaignsTable.id });

    const app = createTestApp();
    const r = await request(app).post("/api/public/sponsor-events").send({
      sponsorId,
      eventType: "impression",
      source: SUMMARY,
      sessionId: `mismatch-summary-${stamp}`,
      slotKey: SUMMARY,
      campaignId: campaign.id,
      creativeId: creative.id,
    });
    expect(r.status).toBe(400);

    await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.campaignId, campaign.id));
    await db.delete(adCampaignsTable).where(eq(adCampaignsTable.id, campaign.id));
    await db.delete(adCreativesTable).where(eq(adCreativesTable.id, creative.id));
  });
});
