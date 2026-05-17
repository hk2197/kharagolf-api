import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  adSlotsTable, adCreativesTable, adCampaignsTable,
  sponsorsTable, sponsorEventsTable, orgMembershipsTable,
} from "@workspace/db";
import { and, eq, desc, asc, gte, lte, inArray, count, sql, ne } from "drizzle-orm";

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

// Default slot taxonomy seeded the first time the admin loads the page.
//
// This list is the single source of truth for ad-campaign slot keys across
// the API. `public.ts` derives its sponsor-event ingestion allow-list and
// rate-limit bypass set from `DEFAULT_SLOT_KEYS` below, so adding a slot
// here automatically opts it into both. Do not duplicate slot keys in
// other allow-lists — extend this list instead.
export const DEFAULT_SLOTS: Array<{ slotKey: string; name: string; description: string; surface: string; mediaTypes: string[]; rotationSeconds: number }> = [
  { slotKey: "tv_ticker", name: "TV Display Ticker", description: "Bottom rotating sponsor ticker on the TV display", surface: "tv", mediaTypes: ["image", "video"], rotationSeconds: 8 },
  { slotKey: "leaderboard_bug", name: "Leaderboard Sponsor Bug", description: "Corner sponsor bug on the live leaderboard", surface: "web", mediaTypes: ["image"], rotationSeconds: 12 },
  { slotKey: "player_card", name: "Player Card Sponsor", description: "Sponsor strip on player profile cards", surface: "web", mediaTypes: ["image"], rotationSeconds: 0 },
  { slotKey: "mobile_splash", name: "Mobile App Splash", description: "Full-screen splash on the player mobile app", surface: "mobile", mediaTypes: ["image"], rotationSeconds: 4 },
  { slotKey: "mobile_leaderboard_footer", name: "Mobile Leaderboard Footer", description: "Sponsor banner pinned below the live leaderboard on the mobile app", surface: "mobile", mediaTypes: ["image"], rotationSeconds: 15 },
  { slotKey: "mobile_scorecard_banner", name: "Mobile Scorecard Banner", description: "Sponsor banner shown on the player's mid-round scorecard", surface: "mobile", mediaTypes: ["image"], rotationSeconds: 15 },
  { slotKey: "mobile_round_summary", name: "Mobile Round Summary", description: "Sponsor banner shown on the post-round summary screen", surface: "mobile", mediaTypes: ["image"], rotationSeconds: 15 },
  { slotKey: "scorecard_footer", name: "Scorecard PDF Footer", description: "Sponsor logo strip in printed/PDF scorecards", surface: "print", mediaTypes: ["image"], rotationSeconds: 0 },
];

/**
 * Set of every ad-campaign slot key. Derived from `DEFAULT_SLOTS` so that
 * adding a slot above automatically registers it with the sponsor-event
 * ingestion allow-list and the ad-campaign rate-limit bypass in
 * `routes/public.ts`. Do not maintain a parallel list elsewhere.
 */
export const DEFAULT_SLOT_KEYS: ReadonlySet<string> = new Set(DEFAULT_SLOTS.map(s => s.slotKey));

export const adCampaignsRouter: IRouter = Router({ mergeParams: true });

// ─── Slots ───────────────────────────────────────────────────────────────────

adCampaignsRouter.get("/slots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const existing = await db.select().from(adSlotsTable)
    .where(eq(adSlotsTable.organizationId, orgId))
    .orderBy(asc(adSlotsTable.name));

  // Seed missing default slots
  const existingKeys = new Set(existing.map(s => s.slotKey));
  const toInsert = DEFAULT_SLOTS.filter(s => !existingKeys.has(s.slotKey));
  if (toInsert.length) {
    await db.insert(adSlotsTable).values(toInsert.map(s => ({ organizationId: orgId, ...s })));
  }

  const slots = await db.select().from(adSlotsTable)
    .where(eq(adSlotsTable.organizationId, orgId))
    .orderBy(asc(adSlotsTable.name));
  res.json(slots);
});

adCampaignsRouter.patch("/slots/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, rotationSeconds, isActive } = req.body ?? {};
  const [slot] = await db.update(adSlotsTable).set({
    name: name ?? undefined,
    description: description ?? undefined,
    rotationSeconds: typeof rotationSeconds === "number" ? rotationSeconds : undefined,
    isActive: typeof isActive === "boolean" ? isActive : undefined,
    updatedAt: new Date(),
  }).where(and(eq(adSlotsTable.id, slotId), eq(adSlotsTable.organizationId, orgId))).returning();
  if (!slot) { { res.status(404).json({ error: "slot not found" }); return; } }
  res.json(slot);
});

// ─── Creatives ───────────────────────────────────────────────────────────────

adCampaignsRouter.get("/creatives", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db.select({
    id: adCreativesTable.id,
    sponsorId: adCreativesTable.sponsorId,
    sponsorName: sponsorsTable.name,
    sponsorLogoUrl: sponsorsTable.logoUrl,
    name: adCreativesTable.name,
    mediaType: adCreativesTable.mediaType,
    mediaUrl: adCreativesTable.mediaUrl,
    clickThroughUrl: adCreativesTable.clickThroughUrl,
    headline: adCreativesTable.headline,
    subheadline: adCreativesTable.subheadline,
    isActive: adCreativesTable.isActive,
    createdAt: adCreativesTable.createdAt,
  })
    .from(adCreativesTable)
    .leftJoin(sponsorsTable, eq(adCreativesTable.sponsorId, sponsorsTable.id))
    .where(eq(adCreativesTable.organizationId, orgId))
    .orderBy(desc(adCreativesTable.createdAt));
  res.json(rows);
});

adCampaignsRouter.post("/creatives", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { sponsorId, name, mediaType, mediaUrl, clickThroughUrl, headline, subheadline } = req.body ?? {};
  if (!sponsorId || !name || !mediaUrl) {
    res.status(400).json({ error: "sponsorId, name, and mediaUrl are required" }); return;
  }
  if (mediaType && mediaType !== "image" && mediaType !== "video") {
    res.status(400).json({ error: "mediaType must be image or video" }); return;
  }
  // Verify sponsor belongs to org
  const [sp] = await db.select({ id: sponsorsTable.id }).from(sponsorsTable)
    .where(and(eq(sponsorsTable.id, parseInt(sponsorId)), eq(sponsorsTable.organizationId, orgId)));
  if (!sp) { { res.status(400).json({ error: "sponsor not in this organization" }); return; } }

  const [creative] = await db.insert(adCreativesTable).values({
    organizationId: orgId,
    sponsorId: parseInt(sponsorId),
    name,
    mediaType: mediaType ?? "image",
    mediaUrl,
    clickThroughUrl: clickThroughUrl || null,
    headline: headline || null,
    subheadline: subheadline || null,
  }).returning();
  res.status(201).json(creative);
});

adCampaignsRouter.patch("/creatives/:creativeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const creativeId = parseInt(String((req.params as Record<string, string>).creativeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = (req.body ?? {}) as Partial<{
    name: string; mediaType: "image" | "video"; mediaUrl: string;
    clickThroughUrl: string | null; headline: string | null; subheadline: string | null;
    isActive: boolean;
  }>;
  const patch: Partial<typeof adCreativesTable.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.mediaType !== undefined) {
    if (body.mediaType !== "image" && body.mediaType !== "video") {
      res.status(400).json({ error: "mediaType must be image or video" }); return;
    }
    patch.mediaType = body.mediaType;
  }
  if (body.mediaUrl !== undefined) patch.mediaUrl = body.mediaUrl;
  if (body.clickThroughUrl !== undefined) patch.clickThroughUrl = body.clickThroughUrl || null;
  if (body.headline !== undefined) patch.headline = body.headline || null;
  if (body.subheadline !== undefined) patch.subheadline = body.subheadline || null;
  if (body.isActive !== undefined) patch.isActive = body.isActive;

  const [creative] = await db.update(adCreativesTable).set(patch)
    .where(and(eq(adCreativesTable.id, creativeId), eq(adCreativesTable.organizationId, orgId)))
    .returning();
  if (!creative) { { res.status(404).json({ error: "creative not found" }); return; } }
  res.json(creative);
});

adCampaignsRouter.delete("/creatives/:creativeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const creativeId = parseInt(String((req.params as Record<string, string>).creativeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(adCreativesTable)
    .where(and(eq(adCreativesTable.id, creativeId), eq(adCreativesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── Campaigns ───────────────────────────────────────────────────────────────

adCampaignsRouter.get("/campaigns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db.select({
    id: adCampaignsTable.id,
    name: adCampaignsTable.name,
    sponsorId: adCampaignsTable.sponsorId,
    sponsorName: sponsorsTable.name,
    slotId: adCampaignsTable.slotId,
    slotKey: adSlotsTable.slotKey,
    slotName: adSlotsTable.name,
    creativeId: adCampaignsTable.creativeId,
    creativeName: adCreativesTable.name,
    creativeMediaUrl: adCreativesTable.mediaUrl,
    creativeMediaType: adCreativesTable.mediaType,
    tournamentId: adCampaignsTable.tournamentId,
    startDate: adCampaignsTable.startDate,
    endDate: adCampaignsTable.endDate,
    weight: adCampaignsTable.weight,
    frequencyCapPerSession: adCampaignsTable.frequencyCapPerSession,
    isActive: adCampaignsTable.isActive,
    notes: adCampaignsTable.notes,
    createdAt: adCampaignsTable.createdAt,
  })
    .from(adCampaignsTable)
    .leftJoin(sponsorsTable, eq(adCampaignsTable.sponsorId, sponsorsTable.id))
    .leftJoin(adSlotsTable, eq(adCampaignsTable.slotId, adSlotsTable.id))
    .leftJoin(adCreativesTable, eq(adCampaignsTable.creativeId, adCreativesTable.id))
    .where(eq(adCampaignsTable.organizationId, orgId))
    .orderBy(desc(adCampaignsTable.startDate));
  res.json(rows);
});

/** Detect overlapping campaigns in the same slot whose summed weights exceed 100. */
async function detectConflicts(orgId: number, slotId: number, startDate: Date, endDate: Date, weight: number, ignoreCampaignId?: number) {
  const overlapping = await db.select({
    id: adCampaignsTable.id,
    name: adCampaignsTable.name,
    weight: adCampaignsTable.weight,
    startDate: adCampaignsTable.startDate,
    endDate: adCampaignsTable.endDate,
  })
    .from(adCampaignsTable)
    .where(and(
      eq(adCampaignsTable.organizationId, orgId),
      eq(adCampaignsTable.slotId, slotId),
      eq(adCampaignsTable.isActive, true),
      lte(adCampaignsTable.startDate, endDate),
      gte(adCampaignsTable.endDate, startDate),
      ignoreCampaignId ? ne(adCampaignsTable.id, ignoreCampaignId) : sql`true`,
    ));
  const totalWeight = overlapping.reduce((sum, c) => sum + (c.weight ?? 0), 0) + weight;
  return { overlapping, totalWeight, overweight: totalWeight > 100 };
}

adCampaignsRouter.post("/campaigns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, sponsorId, slotId, creativeId, tournamentId, startDate, endDate, weight, frequencyCapPerSession, notes, force } = req.body ?? {};
  if (!name || !sponsorId || !slotId || !creativeId || !startDate || !endDate) {
    res.status(400).json({ error: "name, sponsorId, slotId, creativeId, startDate, endDate are required" }); return;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!(start < end)) { { res.status(400).json({ error: "startDate must be before endDate" }); return; } }

  // Validate refs belong to org
  const [creative] = await db.select({ sponsorId: adCreativesTable.sponsorId })
    .from(adCreativesTable)
    .where(and(eq(adCreativesTable.id, parseInt(creativeId)), eq(adCreativesTable.organizationId, orgId)));
  if (!creative) { { res.status(400).json({ error: "creative not in this org" }); return; } }
  if (creative.sponsorId !== parseInt(sponsorId)) {
    res.status(400).json({ error: "creative does not belong to this sponsor" }); return;
  }
  const [slot] = await db.select({ id: adSlotsTable.id }).from(adSlotsTable)
    .where(and(eq(adSlotsTable.id, parseInt(slotId)), eq(adSlotsTable.organizationId, orgId)));
  if (!slot) { { res.status(400).json({ error: "slot not in this org" }); return; } }

  const w = typeof weight === "number" ? weight : 10;
  const conflicts = await detectConflicts(orgId, parseInt(slotId), start, end, w);
  if (conflicts.overweight && !force) {
    res.status(409).json({
      error: "campaign weight conflict",
      detail: `Total weight in this slot for the overlapping period would be ${conflicts.totalWeight} (max 100). Pass force=true to save anyway.`,
      conflicts: conflicts.overlapping,
    });
    return;
  }

  const [campaign] = await db.insert(adCampaignsTable).values({
    organizationId: orgId,
    sponsorId: parseInt(sponsorId),
    slotId: parseInt(slotId),
    creativeId: parseInt(creativeId),
    tournamentId: tournamentId ? parseInt(tournamentId) : null,
    name,
    startDate: start,
    endDate: end,
    weight: w,
    frequencyCapPerSession: typeof frequencyCapPerSession === "number" ? frequencyCapPerSession : 0,
    notes: notes || null,
  }).returning();
  res.status(201).json({ campaign, conflicts: conflicts.overlapping });
});

adCampaignsRouter.patch("/campaigns/:campaignId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const campaignId = parseInt(String((req.params as Record<string, string>).campaignId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(adCampaignsTable)
    .where(and(eq(adCampaignsTable.id, campaignId), eq(adCampaignsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "campaign not found" }); return; } }

  const body = req.body ?? {};
  const start = body.startDate ? new Date(body.startDate) : existing.startDate;
  const end = body.endDate ? new Date(body.endDate) : existing.endDate;
  const weight = typeof body.weight === "number" ? body.weight : existing.weight;
  const slotId = body.slotId ? parseInt(body.slotId) : existing.slotId;

  if (!(start < end)) { { res.status(400).json({ error: "startDate must be before endDate" }); return; } }

  const conflicts = await detectConflicts(orgId, slotId, start, end, weight, campaignId);
  if (conflicts.overweight && !body.force) {
    res.status(409).json({
      error: "campaign weight conflict",
      detail: `Total weight in this slot for the overlapping period would be ${conflicts.totalWeight} (max 100). Pass force=true to save anyway.`,
      conflicts: conflicts.overlapping,
    });
    return;
  }

  // Resolve final sponsor + creative (validate org/sponsor consistency).
  const nextSponsorId = body.sponsorId !== undefined ? parseInt(body.sponsorId) : existing.sponsorId;
  const nextCreativeId = body.creativeId !== undefined ? parseInt(body.creativeId) : existing.creativeId;
  if (body.sponsorId !== undefined || body.creativeId !== undefined) {
    const [sp] = await db.select({ id: sponsorsTable.id }).from(sponsorsTable)
      .where(and(eq(sponsorsTable.id, nextSponsorId), eq(sponsorsTable.organizationId, orgId)));
    if (!sp) { { res.status(400).json({ error: "sponsor not in this organization" }); return; } }
    const [cr] = await db.select({ sponsorId: adCreativesTable.sponsorId }).from(adCreativesTable)
      .where(and(eq(adCreativesTable.id, nextCreativeId), eq(adCreativesTable.organizationId, orgId)));
    if (!cr) { { res.status(400).json({ error: "creative not in this organization" }); return; } }
    if (cr.sponsorId !== nextSponsorId) {
      res.status(400).json({ error: "creative does not belong to this sponsor" }); return;
    }
  }
  if (slotId !== existing.slotId) {
    const [sl] = await db.select({ id: adSlotsTable.id }).from(adSlotsTable)
      .where(and(eq(adSlotsTable.id, slotId), eq(adSlotsTable.organizationId, orgId)));
    if (!sl) { { res.status(400).json({ error: "slot not in this org" }); return; } }
  }

  const patch: Partial<typeof adCampaignsTable.$inferInsert> = {
    startDate: start,
    endDate: end,
    slotId,
    sponsorId: nextSponsorId,
    creativeId: nextCreativeId,
    updatedAt: new Date(),
  };
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.weight === "number") patch.weight = body.weight;
  if (typeof body.frequencyCapPerSession === "number") patch.frequencyCapPerSession = body.frequencyCapPerSession;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (body.notes !== undefined) patch.notes = body.notes || null;
  if (body.tournamentId !== undefined) patch.tournamentId = body.tournamentId === null ? null : parseInt(body.tournamentId);

  const [campaign] = await db.update(adCampaignsTable).set(patch)
    .where(and(eq(adCampaignsTable.id, campaignId), eq(adCampaignsTable.organizationId, orgId))).returning();
  res.json(campaign);
});

adCampaignsRouter.delete("/campaigns/:campaignId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const campaignId = parseInt(String((req.params as Record<string, string>).campaignId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(adCampaignsTable)
    .where(and(eq(adCampaignsTable.id, campaignId), eq(adCampaignsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── Per-slot performance roll-up (admin) ────────────────────────────────────

adCampaignsRouter.get("/campaigns/:campaignId/metrics", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const campaignId = parseInt(String((req.params as Record<string, string>).campaignId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify the campaign belongs to this org before aggregating events.
  const [owned] = await db.select({ id: adCampaignsTable.id }).from(adCampaignsTable)
    .where(and(eq(adCampaignsTable.id, campaignId), eq(adCampaignsTable.organizationId, orgId)));
  if (!owned) { { res.status(404).json({ error: "campaign not found" }); return; } }

  const rows = await db.select({ eventType: sponsorEventsTable.eventType, total: count() })
    .from(sponsorEventsTable)
    .where(and(
      eq(sponsorEventsTable.campaignId, campaignId),
      eq(sponsorEventsTable.organizationId, orgId),
    ))
    .groupBy(sponsorEventsTable.eventType);
  const impressions = Number(rows.find(r => r.eventType === "impression")?.total ?? 0);
  const clicks = Number(rows.find(r => r.eventType === "click")?.total ?? 0);
  res.json({
    impressions, clicks,
    ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
  });
});

adCampaignsRouter.get("/slots/:slotId/metrics", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [slot] = await db.select({ slotKey: adSlotsTable.slotKey }).from(adSlotsTable)
    .where(and(eq(adSlotsTable.id, slotId), eq(adSlotsTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "slot not found" }); return; } }

  const rows = await db.select({
    sponsorId: sponsorEventsTable.sponsorId,
    sponsorName: sponsorsTable.name,
    eventType: sponsorEventsTable.eventType,
    total: count(),
  })
    .from(sponsorEventsTable)
    .leftJoin(sponsorsTable, eq(sponsorEventsTable.sponsorId, sponsorsTable.id))
    .where(and(
      eq(sponsorEventsTable.organizationId, orgId),
      eq(sponsorEventsTable.slotKey, slot.slotKey),
    ))
    .groupBy(sponsorEventsTable.sponsorId, sponsorsTable.name, sponsorEventsTable.eventType);

  res.json(rows.map(r => ({ ...r, total: Number(r.total) })));
});

// ─── Shared delivery helper ──────────────────────────────────────────────────
// Returns the chosen ad creative for a slot using the same delivery rules as
// the public web AdSlot endpoint (tournament targeting, weighted random,
// per-session frequency caps). Returns null when no eligible campaign exists.

export type AdSlotDelivery = {
  slot: { id: number; slotKey: string; rotationSeconds: number };
  campaign: { id: number; weight: number };
  sponsor: { id: number; name: string; logoUrl: string | null; websiteUrl: string | null };
  creative: {
    id: number;
    name: string;
    mediaType: "image" | "video";
    mediaUrl: string;
    clickThroughUrl: string | null;
    headline: string | null;
    subheadline: string | null;
  };
} | { slot: { id: number; slotKey: string; rotationSeconds: number } | null; campaign: null; creative: null; sponsor?: undefined };

export async function selectAdSlotCreative(
  orgId: number,
  slotKey: string,
  sessionId: string,
  tournamentId: number | null,
): Promise<AdSlotDelivery> {
  const [slot] = await db.select().from(adSlotsTable)
    .where(and(
      eq(adSlotsTable.organizationId, orgId),
      eq(adSlotsTable.slotKey, slotKey),
      eq(adSlotsTable.isActive, true),
    ));
  if (!slot) return { slot: null, creative: null, campaign: null };

  const slotInfo = { id: slot.id, slotKey: slot.slotKey, rotationSeconds: slot.rotationSeconds };
  const now = new Date();
  const eligibleRows = await db.select({
    campaignId: adCampaignsTable.id,
    weight: adCampaignsTable.weight,
    frequencyCapPerSession: adCampaignsTable.frequencyCapPerSession,
    sponsorId: adCampaignsTable.sponsorId,
    sponsorName: sponsorsTable.name,
    sponsorLogoUrl: sponsorsTable.logoUrl,
    sponsorWebsiteUrl: sponsorsTable.websiteUrl,
    tournamentId: adCampaignsTable.tournamentId,
    creativeId: adCreativesTable.id,
    creativeName: adCreativesTable.name,
    mediaType: adCreativesTable.mediaType,
    mediaUrl: adCreativesTable.mediaUrl,
    clickThroughUrl: adCreativesTable.clickThroughUrl,
    headline: adCreativesTable.headline,
    subheadline: adCreativesTable.subheadline,
  })
    .from(adCampaignsTable)
    .innerJoin(adCreativesTable, eq(adCampaignsTable.creativeId, adCreativesTable.id))
    .innerJoin(sponsorsTable, eq(adCampaignsTable.sponsorId, sponsorsTable.id))
    .where(and(
      eq(adCampaignsTable.organizationId, orgId),
      eq(adCampaignsTable.slotId, slot.id),
      eq(adCampaignsTable.isActive, true),
      eq(adCreativesTable.isActive, true),
      lte(adCampaignsTable.startDate, now),
      gte(adCampaignsTable.endDate, now),
    ));

  const tournamentMatched = eligibleRows.filter(r => r.tournamentId == null || r.tournamentId === tournamentId);
  if (tournamentMatched.length === 0) return { slot: slotInfo, creative: null, campaign: null };

  const capped = tournamentMatched.filter(r => r.frequencyCapPerSession <= 0);
  const cappedCandidates: typeof tournamentMatched = [...capped];
  const limited = tournamentMatched.filter(r => r.frequencyCapPerSession > 0);
  if (limited.length) {
    const counts = await db.select({
      campaignId: sponsorEventsTable.campaignId,
      total: count(),
    })
      .from(sponsorEventsTable)
      .where(and(
        eq(sponsorEventsTable.sessionId, sessionId),
        eq(sponsorEventsTable.eventType, "impression"),
        inArray(sponsorEventsTable.campaignId, limited.map(r => r.campaignId)),
      ))
      .groupBy(sponsorEventsTable.campaignId);
    const countMap = new Map(counts.map(c => [c.campaignId, Number(c.total)]));
    for (const r of limited) {
      if ((countMap.get(r.campaignId) ?? 0) < r.frequencyCapPerSession) cappedCandidates.push(r);
    }
  }

  if (cappedCandidates.length === 0) return { slot: slotInfo, creative: null, campaign: null };

  const totalWeight = cappedCandidates.reduce((s, c) => s + Math.max(1, c.weight), 0);
  let pick = Math.random() * totalWeight;
  let chosen = cappedCandidates[0];
  for (const c of cappedCandidates) {
    pick -= Math.max(1, c.weight);
    if (pick <= 0) { chosen = c; break; }
  }

  return {
    slot: slotInfo,
    campaign: { id: chosen.campaignId, weight: chosen.weight },
    sponsor: {
      id: chosen.sponsorId,
      name: chosen.sponsorName,
      logoUrl: chosen.sponsorLogoUrl,
      websiteUrl: chosen.sponsorWebsiteUrl,
    },
    creative: {
      id: chosen.creativeId,
      name: chosen.creativeName,
      mediaType: chosen.mediaType as "image" | "video",
      mediaUrl: chosen.mediaUrl,
      clickThroughUrl: chosen.clickThroughUrl,
      headline: chosen.headline,
      subheadline: chosen.subheadline,
    },
  };
}

// ─── Public delivery endpoint ────────────────────────────────────────────────
// GET /public/ad-slot/:orgId/:slotKey?sessionId=&tournamentId=
// Returns a chosen creative or null if no campaign is eligible.

export const publicAdRouter: IRouter = Router({ mergeParams: true });

publicAdRouter.get("/ad-slot/:orgId/:slotKey", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotKey = String((req.params as Record<string, string>).slotKey);
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
  const tournamentId = req.query.tournamentId ? parseInt(String(req.query.tournamentId)) : null;
  if (!orgId || !slotKey || !sessionId) { { res.status(400).json({ error: "invalid" }); return; } }

  // Single source of truth for delivery: shared `selectAdSlotCreative` helper
  // (also used by the printable scorecard PDF, Task #445).
  const result = await selectAdSlotCreative(orgId, slotKey, sessionId, tournamentId);
  res.json(result);
});
