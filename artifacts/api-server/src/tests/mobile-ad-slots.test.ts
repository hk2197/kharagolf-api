/**
 * Integration tests for the mid-round mobile sponsor banner ad slots
 * (Task #736): `mobile_leaderboard_footer` and `mobile_scorecard_banner`.
 *
 * Coverage:
 *   - GET /api/organizations/:orgId/ad-inventory/slots seeds both mobile slots
 *     for a brand-new org with the expected surface and rotation defaults.
 *   - GET /api/public/ad-slot/:orgId/:slotKey
 *       * tournament-scoped campaigns only deliver for the matching tournament
 *       * org-level (tournamentId NULL) campaigns deliver for any tournament
 *       * frequencyCapPerSession is honored across repeated fetches in the
 *         same session and resets across sessions
 *   - POST /api/public/sponsor-events records impressions/clicks for both new
 *     slot keys with the right slotKey/campaignId/creativeId attribution, and
 *     GET /api/organizations/:orgId/ad-inventory/slots/:slotId/metrics rolls
 *     them up under the matching slot.
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

const stamp = Date.now();

let orgId: number;
let adminUserId: number;
let admin: TestUser;
let sponsorId: number;
let courseId: number;
let tournamentAId: number;
let tournamentBId: number;

const FOOTER = "mobile_leaderboard_footer";
const BANNER = "mobile_scorecard_banner";

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_MobileAdSlots_${stamp}`,
    slug: `test-mobads-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `mobads-admin-${stamp}`,
    username: `mobads_admin_${stamp}`,
    email: `mobads_admin_${stamp}@example.com`,
    displayName: "Org Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = u.id;
  admin = { id: adminUserId, username: `mobads_admin_${stamp}`, role: "org_admin", organizationId: orgId };

  const [sp] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name: `Mobile Sponsor ${stamp}`,
    tier: "gold",
  }).returning({ id: sponsorsTable.id });
  sponsorId = sp.id;

  const [c] = await db.insert(coursesTable).values({
    name: `Course Mobads ${stamp}`,
    slug: `course-mobads-${stamp}`,
    organizationId: orgId,
    holes: 18,
  }).returning({ id: coursesTable.id });
  courseId = c.id;

  const [tA] = await db.insert(tournamentsTable).values({
    name: `Tournament A ${stamp}`,
    organizationId: orgId,
    courseId,
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 86_400_000),
  }).returning({ id: tournamentsTable.id });
  tournamentAId = tA.id;

  const [tB] = await db.insert(tournamentsTable).values({
    name: `Tournament B ${stamp}`,
    organizationId: orgId,
    courseId,
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 86_400_000),
  }).returning({ id: tournamentsTable.id });
  tournamentBId = tB.id;
});

afterAll(async () => {
  await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.organizationId, orgId));
  await db.delete(adCampaignsTable).where(eq(adCampaignsTable.organizationId, orgId));
  await db.delete(adCreativesTable).where(eq(adCreativesTable.organizationId, orgId));
  await db.delete(adSlotsTable).where(eq(adSlotsTable.organizationId, orgId));
  await db.delete(sponsorsTable).where(eq(sponsorsTable.organizationId, orgId));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tournamentAId, tournamentBId].filter(Boolean) as number[]));
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function getSlotByKey(slotKey: string): Promise<{ id: number; slotKey: string; name: string; surface: string; rotationSeconds: number } | undefined> {
  const [row] = await db.select({
    id: adSlotsTable.id,
    slotKey: adSlotsTable.slotKey,
    name: adSlotsTable.name,
    surface: adSlotsTable.surface,
    rotationSeconds: adSlotsTable.rotationSeconds,
  })
    .from(adSlotsTable)
    .where(and(eq(adSlotsTable.organizationId, orgId), eq(adSlotsTable.slotKey, slotKey)));
  return row;
}

async function makeCreative(name: string): Promise<number> {
  const [cr] = await db.insert(adCreativesTable).values({
    organizationId: orgId,
    sponsorId,
    name,
    mediaType: "image",
    mediaUrl: "https://cdn.example/banner.png",
    clickThroughUrl: "https://sponsor.example/promo",
  }).returning({ id: adCreativesTable.id });
  return cr.id;
}

async function makeCampaign(opts: {
  name: string;
  slotId: number;
  creativeId: number;
  tournamentId?: number | null;
  frequencyCapPerSession?: number;
}): Promise<number> {
  const [c] = await db.insert(adCampaignsTable).values({
    organizationId: orgId,
    sponsorId,
    slotId: opts.slotId,
    creativeId: opts.creativeId,
    tournamentId: opts.tournamentId ?? null,
    name: opts.name,
    startDate: new Date(Date.now() - 86_400_000),
    endDate: new Date(Date.now() + 7 * 86_400_000),
    weight: 50,
    frequencyCapPerSession: opts.frequencyCapPerSession ?? 0,
  }).returning({ id: adCampaignsTable.id });
  return c.id;
}

describe("mobile ad slot seeding", () => {
  it("seeds mobile_leaderboard_footer and mobile_scorecard_banner on first admin load", async () => {
    // Pre-condition: brand-new org should not have any ad slots yet.
    const existing = await db.select().from(adSlotsTable).where(eq(adSlotsTable.organizationId, orgId));
    expect(existing).toHaveLength(0);

    const app = createTestApp(admin);
    const r = await request(app).get(`/api/organizations/${orgId}/ad-inventory/slots`);
    expect(r.status).toBe(200);

    const slotsByKey = new Map<string, { name: string; surface: string; rotationSeconds: number; isActive: boolean }>();
    for (const s of r.body as Array<{ slotKey: string; name: string; surface: string; rotationSeconds: number; isActive: boolean }>) {
      slotsByKey.set(s.slotKey, s);
    }

    const footer = slotsByKey.get(FOOTER);
    expect(footer, "mobile_leaderboard_footer should be seeded").toBeDefined();
    expect(footer!.surface).toBe("mobile");
    expect(footer!.rotationSeconds).toBe(15);
    expect(footer!.isActive).toBe(true);

    const banner = slotsByKey.get(BANNER);
    expect(banner, "mobile_scorecard_banner should be seeded").toBeDefined();
    expect(banner!.surface).toBe("mobile");
    expect(banner!.rotationSeconds).toBe(15);
    expect(banner!.isActive).toBe(true);

    // Idempotent: a second call must not duplicate rows.
    const r2 = await request(app).get(`/api/organizations/${orgId}/ad-inventory/slots`);
    expect(r2.status).toBe(200);
    const footerCount = (r2.body as Array<{ slotKey: string }>).filter(s => s.slotKey === FOOTER).length;
    const bannerCount = (r2.body as Array<{ slotKey: string }>).filter(s => s.slotKey === BANNER).length;
    expect(footerCount).toBe(1);
    expect(bannerCount).toBe(1);
  });
});

describe("mobile ad slot delivery", () => {
  it("respects tournament targeting on mobile_leaderboard_footer", async () => {
    const slot = await getSlotByKey(FOOTER);
    expect(slot).toBeDefined();

    const creativeId = await makeCreative("Footer Tournament-A Creative");
    const campaignId = await makeCampaign({
      name: "Footer T-A Only",
      slotId: slot!.id,
      creativeId,
      tournamentId: tournamentAId,
    });

    const app = createTestApp();
    const sessionId = `sess-target-${stamp}`;

    // Tournament A → delivers
    const rA = await request(app).get(
      `/api/public/ad-slot/${orgId}/${FOOTER}?sessionId=${sessionId}&tournamentId=${tournamentAId}`,
    );
    expect(rA.status).toBe(200);
    expect(rA.body.creative?.id).toBe(creativeId);
    expect(rA.body.campaign?.id).toBe(campaignId);
    expect(rA.body.slot?.slotKey).toBe(FOOTER);

    // Tournament B → no creative (filtered out)
    const rB = await request(app).get(
      `/api/public/ad-slot/${orgId}/${FOOTER}?sessionId=${sessionId}-b&tournamentId=${tournamentBId}`,
    );
    expect(rB.status).toBe(200);
    expect(rB.body.creative).toBeNull();
    expect(rB.body.campaign).toBeNull();
    // Slot info is still echoed so the client knows the slot exists.
    expect(rB.body.slot?.slotKey).toBe(FOOTER);

    // Cleanup so this campaign doesn't leak into later tests.
    await db.delete(adCampaignsTable).where(eq(adCampaignsTable.id, campaignId));
    await db.delete(adCreativesTable).where(eq(adCreativesTable.id, creativeId));
  });

  it("honors frequencyCapPerSession on mobile_scorecard_banner", async () => {
    const slot = await getSlotByKey(BANNER);
    expect(slot).toBeDefined();

    const creativeId = await makeCreative("Banner Capped Creative");
    const campaignId = await makeCampaign({
      name: "Banner Cap=2",
      slotId: slot!.id,
      creativeId,
      frequencyCapPerSession: 2,
    });

    const app = createTestApp();
    const sessionId = `sess-cap-${stamp}`;

    // Two impressions — each must deliver and be logged with full attribution
    // so the cap engine sees them on the next request.
    for (let i = 0; i < 2; i++) {
      const r = await request(app).get(
        `/api/public/ad-slot/${orgId}/${BANNER}?sessionId=${sessionId}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.creative?.id, `delivery #${i + 1}`).toBe(creativeId);

      const ev = await request(app).post("/api/public/sponsor-events").send({
        sponsorId,
        eventType: "impression",
        source: BANNER,
        sessionId,
        slotKey: BANNER,
        campaignId,
        creativeId,
      });
      expect(ev.status, `event #${i + 1}`).toBe(200);
      expect(ev.body.ok).toBe(true);
    }

    // Third request in the same session is over the cap → no creative.
    const rOver = await request(app).get(
      `/api/public/ad-slot/${orgId}/${BANNER}?sessionId=${sessionId}`,
    );
    expect(rOver.status).toBe(200);
    expect(rOver.body.creative).toBeNull();
    expect(rOver.body.campaign).toBeNull();

    // Different session → cap is per-session, so it should deliver again.
    const rOther = await request(app).get(
      `/api/public/ad-slot/${orgId}/${BANNER}?sessionId=${sessionId}-other`,
    );
    expect(rOther.status).toBe(200);
    expect(rOther.body.creative?.id).toBe(creativeId);

    await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.campaignId, campaignId));
    await db.delete(adCampaignsTable).where(eq(adCampaignsTable.id, campaignId));
    await db.delete(adCreativesTable).where(eq(adCreativesTable.id, creativeId));
  });
});

describe("mobile ad slot event roll-up", () => {
  it("records and rolls up impressions/clicks under the right slotKey for both mobile slots", async () => {
    const footerSlot = await getSlotByKey(FOOTER);
    const bannerSlot = await getSlotByKey(BANNER);
    expect(footerSlot).toBeDefined();
    expect(bannerSlot).toBeDefined();

    const footerCreativeId = await makeCreative("Footer Rollup Creative");
    const footerCampaignId = await makeCampaign({
      name: "Footer Rollup",
      slotId: footerSlot!.id,
      creativeId: footerCreativeId,
    });
    const bannerCreativeId = await makeCreative("Banner Rollup Creative");
    const bannerCampaignId = await makeCampaign({
      name: "Banner Rollup",
      slotId: bannerSlot!.id,
      creativeId: bannerCreativeId,
    });

    const app = createTestApp();

    async function postEvent(slotKey: string, campaignId: number, creativeId: number, eventType: "impression" | "click", sessionId: string) {
      const r = await request(app).post("/api/public/sponsor-events").send({
        sponsorId,
        eventType,
        source: slotKey,
        sessionId,
        slotKey,
        campaignId,
        creativeId,
      });
      expect(r.status, `${slotKey} ${eventType}`).toBe(200);
      expect(r.body.ok, `${slotKey} ${eventType} body`).toBe(true);
    }

    // 3 footer impressions + 1 footer click; 2 banner impressions + 1 banner click.
    // Use distinct sessions so legacy per-source click rate-limit doesn't drop events.
    for (let i = 0; i < 3; i++) {
      await postEvent(FOOTER, footerCampaignId, footerCreativeId, "impression", `roll-footer-i-${i}-${stamp}`);
    }
    await postEvent(FOOTER, footerCampaignId, footerCreativeId, "click", `roll-footer-c-${stamp}`);
    for (let i = 0; i < 2; i++) {
      await postEvent(BANNER, bannerCampaignId, bannerCreativeId, "impression", `roll-banner-i-${i}-${stamp}`);
    }
    await postEvent(BANNER, bannerCampaignId, bannerCreativeId, "click", `roll-banner-c-${stamp}`);

    // Per-row attribution lands in the events table.
    const persisted = await db.select({
      slotKey: sponsorEventsTable.slotKey,
      eventType: sponsorEventsTable.eventType,
      campaignId: sponsorEventsTable.campaignId,
      creativeId: sponsorEventsTable.creativeId,
    })
      .from(sponsorEventsTable)
      .where(and(
        eq(sponsorEventsTable.organizationId, orgId),
        inArray(sponsorEventsTable.slotKey, [FOOTER, BANNER]),
      ));
    const footerRows = persisted.filter(r => r.slotKey === FOOTER);
    const bannerRows = persisted.filter(r => r.slotKey === BANNER);
    expect(footerRows.filter(r => r.eventType === "impression")).toHaveLength(3);
    expect(footerRows.filter(r => r.eventType === "click")).toHaveLength(1);
    expect(bannerRows.filter(r => r.eventType === "impression")).toHaveLength(2);
    expect(bannerRows.filter(r => r.eventType === "click")).toHaveLength(1);
    expect(footerRows.every(r => r.campaignId === footerCampaignId && r.creativeId === footerCreativeId)).toBe(true);
    expect(bannerRows.every(r => r.campaignId === bannerCampaignId && r.creativeId === bannerCreativeId)).toBe(true);

    // Per-slot admin metrics roll up under the right slot.
    const adminApp = createTestApp(admin);

    const footerMetricsRes = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/slots/${footerSlot!.id}/metrics`,
    );
    expect(footerMetricsRes.status).toBe(200);
    const footerMine = (footerMetricsRes.body as Array<{ sponsorId: number; eventType: string; total: number }>)
      .filter(m => m.sponsorId === sponsorId);
    expect(footerMine.find(m => m.eventType === "impression")?.total).toBe(3);
    expect(footerMine.find(m => m.eventType === "click")?.total).toBe(1);

    const bannerMetricsRes = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/slots/${bannerSlot!.id}/metrics`,
    );
    expect(bannerMetricsRes.status).toBe(200);
    const bannerMine = (bannerMetricsRes.body as Array<{ sponsorId: number; eventType: string; total: number }>)
      .filter(m => m.sponsorId === sponsorId);
    expect(bannerMine.find(m => m.eventType === "impression")?.total).toBe(2);
    expect(bannerMine.find(m => m.eventType === "click")?.total).toBe(1);

    // Per-campaign metrics endpoint reports the same totals.
    const footerCampMetrics = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/campaigns/${footerCampaignId}/metrics`,
    );
    expect(footerCampMetrics.status).toBe(200);
    expect(footerCampMetrics.body.impressions).toBe(3);
    expect(footerCampMetrics.body.clicks).toBe(1);

    const bannerCampMetrics = await request(adminApp).get(
      `/api/organizations/${orgId}/ad-inventory/campaigns/${bannerCampaignId}/metrics`,
    );
    expect(bannerCampMetrics.status).toBe(200);
    expect(bannerCampMetrics.body.impressions).toBe(2);
    expect(bannerCampMetrics.body.clicks).toBe(1);
  });

  it("rejects ad events whose slotKey/source/campaign attribution is mismatched", async () => {
    const footerSlot = await getSlotByKey(FOOTER);
    const bannerSlot = await getSlotByKey(BANNER);
    expect(footerSlot).toBeDefined();
    expect(bannerSlot).toBeDefined();

    const footerCreativeId = await makeCreative("Footer Mismatch Creative");
    const footerCampaignId = await makeCampaign({
      name: "Footer Mismatch",
      slotId: footerSlot!.id,
      creativeId: footerCreativeId,
    });

    const app = createTestApp();
    // Source says banner, but the campaign actually belongs to the footer slot
    // → must be rejected so reporting can't be poisoned.
    const r = await request(app).post("/api/public/sponsor-events").send({
      sponsorId,
      eventType: "impression",
      source: BANNER,
      sessionId: `mismatch-${stamp}`,
      slotKey: BANNER,
      campaignId: footerCampaignId,
      creativeId: footerCreativeId,
    });
    expect(r.status).toBe(400);

    await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.campaignId, footerCampaignId));
    await db.delete(adCampaignsTable).where(eq(adCampaignsTable.id, footerCampaignId));
    await db.delete(adCreativesTable).where(eq(adCreativesTable.id, footerCreativeId));
  });
});
