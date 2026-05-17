import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  sponsorsTable, holeSponsorsTable, orgMembershipsTable, tournamentsTable,
  sponsorEventsTable, sponsorshipPackagesTable, sponsorshipAssignmentsTable, sponsorInvoicesTable,
  organizationsTable, adCampaignsTable, adCreativesTable, adSlotsTable,
} from "@workspace/db";
import { eq, and, asc, inArray, gte, count, sql, desc } from "drizzle-orm";
import { gateSponsorCreate } from "../lib/featureGate";
import { getRazorpayClient } from "../lib/razorpay";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const router: IRouter = Router({ mergeParams: true });

/** Returns true only for org_admin / tournament_director / super_admin. */
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number((user as any).organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

/** Verifies the given tournament belongs to the given org — prevents cross-org tampering. */
async function requireTournamentInOrg(res: Response, tournamentId: number, orgId: number): Promise<boolean> {
  const [t] = await db.select({ id: tournamentsTable.id }).from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!t) { res.status(403).json({ error: "Tournament does not belong to this organization" }); return false; }
  return true;
}

// ─── Per-tournament sponsor endpoints (existing) ─────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/sponsors
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const sponsors = await db.select().from(sponsorsTable)
    .where(eq(sponsorsTable.tournamentId, tournamentId))
    .orderBy(asc(sponsorsTable.displayOrder), asc(sponsorsTable.name));

  const withHoles = await Promise.all(sponsors.map(async (s) => {
    const holes = await db.select({ holeNumber: holeSponsorsTable.holeNumber })
      .from(holeSponsorsTable)
      .where(eq(holeSponsorsTable.sponsorId, s.id));
    return { ...s, holeNumbers: holes.map((h) => h.holeNumber) };
  }));

  res.json(withHoles);
});

// POST /organizations/:orgId/tournaments/:tournamentId/sponsors
// Gated: requires Starter plan (sponsorLogos)
router.post("/", gateSponsorCreate(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { name, tier, logoUrl, websiteUrl, description, displayOrder, holeNumbers } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [sponsor] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    tournamentId,
    name,
    tier: tier ?? "gold",
    logoUrl,
    websiteUrl,
    description,
    displayOrder: displayOrder ?? 0,
  }).returning();

  if (holeNumbers && Array.isArray(holeNumbers)) {
    for (const h of holeNumbers as number[]) {
      await db.insert(holeSponsorsTable)
        .values({ sponsorId: sponsor.id, tournamentId, holeNumber: h })
        .onConflictDoUpdate({ target: [holeSponsorsTable.tournamentId, holeSponsorsTable.holeNumber], set: { sponsorId: sponsor.id } });
    }
  }

  res.status(201).json(sponsor);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/sponsors/:sponsorId
router.put("/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { name, tier, logoUrl, websiteUrl, description, displayOrder, isActive, holeNumbers } = req.body;
  const [sponsor] = await db.update(sponsorsTable)
    .set({ name, tier, logoUrl, websiteUrl, description, displayOrder, isActive })
    .where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.tournamentId, tournamentId)))
    .returning();
  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  if (holeNumbers !== undefined) {
    await db.delete(holeSponsorsTable).where(eq(holeSponsorsTable.sponsorId, sponsorId));
    for (const h of holeNumbers as number[]) {
      await db.insert(holeSponsorsTable)
        .values({ sponsorId, tournamentId, holeNumber: h })
        .onConflictDoUpdate({ target: [holeSponsorsTable.tournamentId, holeSponsorsTable.holeNumber], set: { sponsorId } });
    }
  }

  res.json(sponsor);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/sponsors/:sponsorId
router.delete("/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;
  await db.delete(sponsorsTable).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// GET /organizations/:orgId/tournaments/:tournamentId/sponsors/analytics/:sponsorId
router.get("/analytics/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const allTournaments = req.query.allTournaments === "true";

  let since: Date;
  let until: Date = new Date();
  let days = 30;

  if (req.query.from && req.query.to) {
    const fromDate = new Date(req.query.from as string);
    const toDate = new Date(req.query.to as string);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      res.status(400).json({ error: "Invalid date range" }); return;
    }
    since = fromDate;
    until = toDate;
    days = Math.round((until.getTime() - since.getTime()) / 86400_000);
  } else {
    days = Math.min(90, Math.max(1, parseInt((req.query.days as string) ?? "30") || 30));
    since = new Date(Date.now() - days * 86400_000);
  }

  const baseWhere = and(
    eq(sponsorEventsTable.sponsorId, sponsorId),
    eq(sponsorEventsTable.organizationId, orgId),
    gte(sponsorEventsTable.recordedAt, since),
    sql`${sponsorEventsTable.recordedAt} <= ${until.toISOString()}`,
    ...(allTournaments ? [] : [
      sql`(${sponsorEventsTable.tournamentId} = ${tournamentId} OR ${sponsorEventsTable.tournamentId} IS NULL)`,
    ]),
  );

  const [totals, bySource, byDay] = await Promise.all([
    db.select({ eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable).where(baseWhere).groupBy(sponsorEventsTable.eventType),

    db.select({ source: sponsorEventsTable.source, eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable).where(baseWhere).groupBy(sponsorEventsTable.source, sponsorEventsTable.eventType),

    db.select({
      day: sql<string>`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      eventType: sponsorEventsTable.eventType,
      total: count(),
    })
      .from(sponsorEventsTable).where(baseWhere)
      .groupBy(sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, sponsorEventsTable.eventType)
      .orderBy(sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),
  ]);

  const impressions = totals.find(r => r.eventType === "impression")?.total ?? 0;
  const clicks = totals.find(r => r.eventType === "click")?.total ?? 0;
  const ctr = impressions > 0 ? Number(((Number(clicks) / Number(impressions)) * 100).toFixed(1)) : 0;

  res.json({
    impressions: Number(impressions), clicks: Number(clicks), ctr,
    bySource, byDay, days, allTournaments,
    from: since.toISOString().slice(0, 10),
    to: until.toISOString().slice(0, 10),
  });
});

export default router;

// ─── Org-level sponsor CRM router ──────────────────────────────────────────

export const orgSponsorsRouter: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/sponsors — list all sponsors for org (CRM view)
orgSponsorsRouter.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const sponsors = await db.select().from(sponsorsTable)
    .where(eq(sponsorsTable.organizationId, orgId))
    .orderBy(asc(sponsorsTable.name));

  const since30d = new Date(Date.now() - 30 * 86400_000);
  const enriched = await Promise.all(sponsors.map(async (s) => {
    const [invoiceSummary, assignments, analyticsRows] = await Promise.all([
      db.select({
        total: count(),
        paid: sql<number>`count(*) filter (where payment_status = 'paid')`,
        outstanding: sql<number>`count(*) filter (where payment_status != 'paid')`,
        totalAmount: sql<number>`coalesce(sum(amount), 0)`,
        paidAmount: sql<number>`coalesce(sum(amount) filter (where payment_status = 'paid'), 0)`,
      }).from(sponsorInvoicesTable).where(eq(sponsorInvoicesTable.sponsorId, s.id)).then(r => r[0]),

      db.select({
        id: sponsorshipAssignmentsTable.id,
        assignmentType: sponsorshipAssignmentsTable.assignmentType,
        tournamentId: sponsorshipAssignmentsTable.tournamentId,
        holeNumber: sponsorshipAssignmentsTable.holeNumber,
        packageId: sponsorshipAssignmentsTable.packageId,
      }).from(sponsorshipAssignmentsTable).where(eq(sponsorshipAssignmentsTable.sponsorId, s.id)),

      db.select({ eventType: sponsorEventsTable.eventType, source: sponsorEventsTable.source, total: count() })
        .from(sponsorEventsTable)
        .where(and(eq(sponsorEventsTable.sponsorId, s.id), gte(sponsorEventsTable.recordedAt, since30d)))
        .groupBy(sponsorEventsTable.eventType, sponsorEventsTable.source),
    ]);

    const impressions = Number(analyticsRows.filter(r => r.eventType === "impression").reduce((acc, r) => acc + Number(r.total), 0));
    const clicks = Number(analyticsRows.filter(r => r.eventType === "click").reduce((acc, r) => acc + Number(r.total), 0));
    const analytics = {
      impressions,
      clicks,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(1)) : 0,
      days: 30,
      bySource: analyticsRows.map(r => ({ source: r.source, eventType: r.eventType, total: Number(r.total) })),
    };

    const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = s;
    return { ...safeSponsor, invoiceSummary, assignments, analytics };
  }));

  res.json(enriched);
});

// POST /organizations/:orgId/sponsors — create sponsor in CRM
orgSponsorsRouter.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, tier, logoUrl, websiteUrl, description, contactEmail, contactName, contactPhone, pipelineStatus, notes, renewalDate } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [sponsor] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name, tier: tier ?? "gold", logoUrl, websiteUrl, description,
    contactEmail, contactName, contactPhone,
    pipelineStatus: pipelineStatus ?? "prospect",
    notes,
    renewalDate: renewalDate ? new Date(renewalDate) : undefined,
  }).returning();

  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.status(201).json(safeSponsor);
});

// GET /organizations/:orgId/sponsors/pending-asset-count — badge count for admin
orgSponsorsRouter.get("/pending-asset-count", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [row] = await db.select({
    count: sql<number>`count(*) filter (where ${sponsorsTable.pendingLogoUrl} is not null or ${sponsorsTable.pendingBannerUrl} is not null)`,
  }).from(sponsorsTable).where(eq(sponsorsTable.organizationId, orgId));
  res.json({ count: Number(row?.count ?? 0) });
});

// GET /organizations/:orgId/sponsors/:sponsorId
orgSponsorsRouter.get("/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [sponsor] = await db.select().from(sponsorsTable)
    .where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  const since30d = new Date(Date.now() - 30 * 86400_000);
  const [invoices, assignments, analyticsRows, analyticsSourceRows] = await Promise.all([
    db.select().from(sponsorInvoicesTable).where(eq(sponsorInvoicesTable.sponsorId, sponsorId)).orderBy(desc(sponsorInvoicesTable.createdAt)),
    db.select().from(sponsorshipAssignmentsTable).where(eq(sponsorshipAssignmentsTable.sponsorId, sponsorId)),
    db.select({ eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable)
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), gte(sponsorEventsTable.recordedAt, since30d)))
      .groupBy(sponsorEventsTable.eventType),
    db.select({ source: sponsorEventsTable.source, eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable)
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), gte(sponsorEventsTable.recordedAt, since30d)))
      .groupBy(sponsorEventsTable.source, sponsorEventsTable.eventType),
  ]);

  const adminImpressions = Number(analyticsRows.find(r => r.eventType === "impression")?.total ?? 0);
  const adminClicks = Number(analyticsRows.find(r => r.eventType === "click")?.total ?? 0);
  const analytics = {
    impressions: adminImpressions,
    clicks: adminClicks,
    ctr: adminImpressions > 0 ? Number(((adminClicks / adminImpressions) * 100).toFixed(1)) : 0,
    days: 30,
    bySource: analyticsSourceRows.map(r => ({ source: r.source, eventType: r.eventType, total: Number(r.total) })),
  };

  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.json({ ...safeSponsor, invoices, assignments, analytics });
});

// PUT /organizations/:orgId/sponsors/:sponsorId
orgSponsorsRouter.put("/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, tier, logoUrl, websiteUrl, description, contactEmail, contactName, contactPhone, pipelineStatus, notes, renewalDate, isActive } = req.body;

  const [sponsor] = await db.update(sponsorsTable).set({
    name, tier, logoUrl, websiteUrl, description,
    contactEmail, contactName, contactPhone,
    pipelineStatus, notes, isActive,
    renewalDate: renewalDate ? new Date(renewalDate) : undefined,
    updatedAt: new Date(),
  }).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId))).returning();

  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.json(safeSponsor);
});

// DELETE /organizations/:orgId/sponsors/:sponsorId
orgSponsorsRouter.delete("/:sponsorId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(sponsorsTable).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/sponsors/:sponsorId/set-portal-password
orgSponsorsRouter.post("/:sponsorId/set-portal-password", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { password } = req.body;
  if (!password || password.length < 8) { { res.status(400).json({ error: "Password must be at least 8 characters" }); return; } }

  const hash = await bcrypt.hash(password, 12);
  await db.update(sponsorsTable).set({ portalPasswordHash: hash }).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/sponsors/:sponsorId/generate-invite
orgSponsorsRouter.post("/:sponsorId/generate-invite", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [sponsor] = await db.select({ id: sponsorsTable.id })
    .from(sponsorsTable)
    .where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 72 * 3600_000);
  await db.update(sponsorsTable).set({ portalToken: token, portalTokenExpiry: expiry })
    .where(eq(sponsorsTable.id, sponsorId));

  res.json({ invitePath: `/sponsor-portal?invite=${token}` });
});

// POST /organizations/:orgId/sponsors/:sponsorId/approve-asset
orgSponsorsRouter.post("/:sponsorId/approve-asset", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { assetType } = req.body;
  const [sponsor] = await db.select().from(sponsorsTable)
    .where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  if (assetType === "banner") {
    if (!sponsor.pendingBannerUrl) { { res.status(400).json({ error: "No pending banner" }); return; } }
    await db.update(sponsorsTable).set({
      bannerUrl: sponsor.pendingBannerUrl,
      pendingBannerUrl: null,
      assetRejectionFeedback: null,
      updatedAt: new Date(),
    }).where(eq(sponsorsTable.id, sponsorId));
  } else {
    if (!sponsor.pendingLogoUrl) { { res.status(400).json({ error: "No pending logo" }); return; } }
    await db.update(sponsorsTable).set({
      logoUrl: sponsor.pendingLogoUrl,
      pendingLogoUrl: null,
      assetRejectionFeedback: null,
      updatedAt: new Date(),
    }).where(eq(sponsorsTable.id, sponsorId));
  }
  res.json({ ok: true });
});

// POST /organizations/:orgId/sponsors/:sponsorId/reject-asset
orgSponsorsRouter.post("/:sponsorId/reject-asset", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { assetType, feedback } = req.body;
  if (assetType === "banner") {
    await db.update(sponsorsTable).set({
      pendingBannerUrl: null,
      assetRejectionFeedback: feedback ?? null,
      updatedAt: new Date(),
    }).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  } else {
    await db.update(sponsorsTable).set({
      pendingLogoUrl: null,
      assetRejectionFeedback: feedback ?? null,
      updatedAt: new Date(),
    }).where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId)));
  }
  res.json({ ok: true });
});

// POST /organizations/:orgId/sponsors/:sponsorId/upload-logo
orgSponsorsRouter.post("/:sponsorId/upload-logo", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sponsorId = parseInt(String((req.params as Record<string, string>).sponsorId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { logoUrl } = req.body;
  if (!logoUrl) { { res.status(400).json({ error: "logoUrl is required" }); return; } }

  const [sponsor] = await db.update(sponsorsTable).set({ logoUrl, updatedAt: new Date() })
    .where(and(eq(sponsorsTable.id, sponsorId), eq(sponsorsTable.organizationId, orgId))).returning();
  if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.json(safeSponsor);
});

// ─── Sponsorship Packages ─────────────────────────────────────────────────

// GET /organizations/:orgId/sponsorship-packages
export const packagesRouter: IRouter = Router({ mergeParams: true });

packagesRouter.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const packages = await db.select().from(sponsorshipPackagesTable)
    .where(eq(sponsorshipPackagesTable.organizationId, orgId))
    .orderBy(asc(sponsorshipPackagesTable.displayOrder), asc(sponsorshipPackagesTable.name));
  res.json(packages);
});

packagesRouter.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, price, currency, deliverables, packageType, displayOrder } = req.body;
  if (!name || !price) { { res.status(400).json({ error: "name and price are required" }); return; } }

  const [pkg] = await db.insert(sponsorshipPackagesTable).values({
    organizationId: orgId, name, description, price: String(price),
    currency: currency ?? "INR", deliverables: deliverables ?? [],
    packageType: packageType ?? "event", displayOrder: displayOrder ?? 0,
  }).returning();
  res.status(201).json(pkg);
});

packagesRouter.put("/:packageId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const packageId = parseInt(String((req.params as Record<string, string>).packageId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, price, currency, deliverables, packageType, displayOrder, isActive } = req.body;
  const [pkg] = await db.update(sponsorshipPackagesTable).set({
    name, description, price: price ? String(price) : undefined, currency,
    deliverables, packageType, displayOrder, isActive, updatedAt: new Date(),
  }).where(and(eq(sponsorshipPackagesTable.id, packageId), eq(sponsorshipPackagesTable.organizationId, orgId))).returning();
  if (!pkg) { { res.status(404).json({ error: "Package not found" }); return; } }
  res.json(pkg);
});

packagesRouter.delete("/:packageId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const packageId = parseInt(String((req.params as Record<string, string>).packageId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(sponsorshipPackagesTable).where(and(eq(sponsorshipPackagesTable.id, packageId), eq(sponsorshipPackagesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── Sponsorship Assignments ──────────────────────────────────────────────

export const assignmentsRouter: IRouter = Router({ mergeParams: true });

assignmentsRouter.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const assignments = await db.select({
    id: sponsorshipAssignmentsTable.id,
    organizationId: sponsorshipAssignmentsTable.organizationId,
    sponsorId: sponsorshipAssignmentsTable.sponsorId,
    packageId: sponsorshipAssignmentsTable.packageId,
    tournamentId: sponsorshipAssignmentsTable.tournamentId,
    holeNumber: sponsorshipAssignmentsTable.holeNumber,
    assignmentType: sponsorshipAssignmentsTable.assignmentType,
    notes: sponsorshipAssignmentsTable.notes,
    isActive: sponsorshipAssignmentsTable.isActive,
    createdAt: sponsorshipAssignmentsTable.createdAt,
    sponsorName: sponsorsTable.name,
    sponsorLogoUrl: sponsorsTable.logoUrl,
    tournamentName: tournamentsTable.name,
    packageName: sponsorshipPackagesTable.name,
  })
    .from(sponsorshipAssignmentsTable)
    .leftJoin(sponsorsTable, eq(sponsorshipAssignmentsTable.sponsorId, sponsorsTable.id))
    .leftJoin(tournamentsTable, eq(sponsorshipAssignmentsTable.tournamentId, tournamentsTable.id))
    .leftJoin(sponsorshipPackagesTable, eq(sponsorshipAssignmentsTable.packageId, sponsorshipPackagesTable.id))
    .where(eq(sponsorshipAssignmentsTable.organizationId, orgId))
    .orderBy(desc(sponsorshipAssignmentsTable.createdAt));

  res.json(assignments);
});

assignmentsRouter.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { sponsorId, packageId, tournamentId, holeNumber, assignmentType, notes } = req.body;
  if (!sponsorId) { { res.status(400).json({ error: "sponsorId is required" }); return; } }

  const [assignment] = await db.insert(sponsorshipAssignmentsTable).values({
    organizationId: orgId,
    sponsorId: parseInt(sponsorId),
    packageId: packageId ? parseInt(packageId) : undefined,
    tournamentId: tournamentId ? parseInt(tournamentId) : undefined,
    holeNumber: holeNumber ? parseInt(holeNumber) : undefined,
    assignmentType: assignmentType ?? "event",
    notes,
  }).returning();
  res.status(201).json(assignment);
});

assignmentsRouter.delete("/:assignmentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const assignmentId = parseInt(String((req.params as Record<string, string>).assignmentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(sponsorshipAssignmentsTable).where(and(eq(sponsorshipAssignmentsTable.id, assignmentId), eq(sponsorshipAssignmentsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── Sponsor Invoices ─────────────────────────────────────────────────────

export const invoicesRouter: IRouter = Router({ mergeParams: true });

invoicesRouter.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const invoices = await db.select({
    id: sponsorInvoicesTable.id,
    organizationId: sponsorInvoicesTable.organizationId,
    sponsorId: sponsorInvoicesTable.sponsorId,
    assignmentId: sponsorInvoicesTable.assignmentId,
    packageId: sponsorInvoicesTable.packageId,
    invoiceNumber: sponsorInvoicesTable.invoiceNumber,
    amount: sponsorInvoicesTable.amount,
    currency: sponsorInvoicesTable.currency,
    paymentStatus: sponsorInvoicesTable.paymentStatus,
    razorpayPaymentLinkUrl: sponsorInvoicesTable.razorpayPaymentLinkUrl,
    razorpayPaymentId: sponsorInvoicesTable.razorpayPaymentId,
    dueDate: sponsorInvoicesTable.dueDate,
    paidAt: sponsorInvoicesTable.paidAt,
    notes: sponsorInvoicesTable.notes,
    createdAt: sponsorInvoicesTable.createdAt,
    sponsorName: sponsorsTable.name,
    sponsorContactEmail: sponsorsTable.contactEmail,
  })
    .from(sponsorInvoicesTable)
    .leftJoin(sponsorsTable, eq(sponsorInvoicesTable.sponsorId, sponsorsTable.id))
    .where(eq(sponsorInvoicesTable.organizationId, orgId))
    .orderBy(desc(sponsorInvoicesTable.createdAt));

  res.json(invoices);
});

invoicesRouter.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { sponsorId, assignmentId, packageId, amount, currency, dueDate, notes, createPaymentLink } = req.body;
  if (!sponsorId || !amount) { { res.status(400).json({ error: "sponsorId and amount are required" }); return; } }

  const [lastInvoice] = await db.select({ invoiceNumber: sponsorInvoicesTable.invoiceNumber })
    .from(sponsorInvoicesTable)
    .where(eq(sponsorInvoicesTable.organizationId, orgId))
    .orderBy(desc(sponsorInvoicesTable.createdAt))
    .limit(1);

  const nextNum = lastInvoice
    ? parseInt(lastInvoice.invoiceNumber.replace(/\D/g, "") || "0") + 1
    : 1;
  const invoiceNumber = `SPNS-${String(orgId).padStart(3, "0")}-${String(nextNum).padStart(4, "0")}`;

  let paymentLinkId: string | undefined;
  let paymentLinkUrl: string | undefined;

  if (createPaymentLink) {
    try {
      const [sponsor] = await db.select({ name: sponsorsTable.name, contactEmail: sponsorsTable.contactEmail, contactPhone: sponsorsTable.contactPhone })
        .from(sponsorsTable).where(eq(sponsorsTable.id, parseInt(sponsorId)));
      const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

      const rz = getRazorpayClient();
      const link = await rz.paymentLink.create({
        amount: Math.round(parseFloat(String(amount)) * 100),
        currency: (currency ?? "INR").toUpperCase(),
        description: `Sponsorship invoice ${invoiceNumber} — ${org?.name ?? ""}`,
        customer: {
          name: sponsor?.name,
          email: sponsor?.contactEmail ?? undefined,
          contact: sponsor?.contactPhone ?? undefined,
        },
        notify: { email: !!(sponsor?.contactEmail), sms: false },
        reference_id: invoiceNumber,
        notes: { orgId: String(orgId), sponsorId: String(sponsorId), invoiceNumber },
      });
      paymentLinkId = link.id;
      paymentLinkUrl = link.short_url;
    } catch (err) {
    }
  }

  const [invoice] = await db.insert(sponsorInvoicesTable).values({
    organizationId: orgId,
    sponsorId: parseInt(sponsorId),
    assignmentId: assignmentId ? parseInt(assignmentId) : undefined,
    packageId: packageId ? parseInt(packageId) : undefined,
    invoiceNumber,
    amount: String(amount),
    currency: currency ?? "INR",
    dueDate: dueDate ? new Date(dueDate) : undefined,
    notes,
    razorpayPaymentLinkId: paymentLinkId,
    razorpayPaymentLinkUrl: paymentLinkUrl,
  }).returning();

  res.status(201).json(invoice);
});

// PATCH /organizations/:orgId/sponsor-invoices/:invoiceId — mark paid/unpaid
invoicesRouter.patch("/:invoiceId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const invoiceId = parseInt(String((req.params as Record<string, string>).invoiceId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { paymentStatus, razorpayPaymentId, notes } = req.body;
  const [invoice] = await db.update(sponsorInvoicesTable).set({
    paymentStatus,
    razorpayPaymentId,
    notes,
    paidAt: paymentStatus === "paid" ? new Date() : undefined,
    updatedAt: new Date(),
  }).where(and(eq(sponsorInvoicesTable.id, invoiceId), eq(sponsorInvoicesTable.organizationId, orgId))).returning();

  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }
  res.json(invoice);
});

invoicesRouter.delete("/:invoiceId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const invoiceId = parseInt(String((req.params as Record<string, string>).invoiceId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(sponsorInvoicesTable).where(and(eq(sponsorInvoicesTable.id, invoiceId), eq(sponsorInvoicesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── Sponsor Portal Auth ──────────────────────────────────────────────────

export const sponsorPortalRouter: IRouter = Router({ mergeParams: true });

/** Sign a sponsor portal token (HMAC-SHA256, base64url, expires in 7 days) */
function signSponsorToken(payload: { sponsorId: number; orgId: number; exp: number }): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET environment variable is required for sponsor portal auth");
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Verify and decode a sponsor portal token; returns null if invalid/expired */
function verifySponsorToken(token: string): { sponsorId: number; orgId: number } | null {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return null;
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as { sponsorId: number; orgId: number; exp: number };
    if (payload.exp < Date.now()) return null;
    return { sponsorId: payload.sponsorId, orgId: payload.orgId };
  } catch {
    return null;
  }
}

// POST /sponsor-portal/login
sponsorPortalRouter.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) { { res.status(400).json({ error: "email and password are required" }); return; } }

  const matches = await db.select().from(sponsorsTable)
    .where(eq(sponsorsTable.contactEmail, email.toLowerCase().trim()))
    .limit(2);

  // Prevent ambiguous login if multiple sponsors share the same email
  if (matches.length !== 1 || !matches[0].portalPasswordHash) {
    res.status(401).json({ error: "Invalid credentials" }); return;
  }
  const sponsor = matches[0];

  const valid = await bcrypt.compare(password, sponsor.portalPasswordHash!);
  if (!valid) { { res.status(401).json({ error: "Invalid credentials" }); return; } }

  const token = signSponsorToken({ sponsorId: sponsor.id, orgId: sponsor.organizationId, exp: Date.now() + 7 * 86400_000 });

  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.json({ token, sponsor: safeSponsor });
});

// POST /sponsor-portal/claim-invite — first-time setup: set password via invite token
sponsorPortalRouter.post("/claim-invite", async (req: Request, res: Response) => {
  const { token: inviteToken, password } = req.body;
  if (!inviteToken || !password) { { res.status(400).json({ error: "token and password are required" }); return; } }
  if (password.length < 8) { { res.status(400).json({ error: "Password must be at least 8 characters" }); return; } }

  const [sponsor] = await db.select().from(sponsorsTable)
    .where(eq(sponsorsTable.portalToken, inviteToken))
    .limit(1);

  if (!sponsor || !sponsor.portalTokenExpiry || sponsor.portalTokenExpiry < new Date()) {
    res.status(400).json({ error: "Invalid or expired invite link" }); return;
  }

  const hash = await bcrypt.hash(password, 12);
  await db.update(sponsorsTable).set({
    portalPasswordHash: hash,
    portalToken: null,
    portalTokenExpiry: null,
    updatedAt: new Date(),
  }).where(eq(sponsorsTable.id, sponsor.id));

  const sessionToken = signSponsorToken({ sponsorId: sponsor.id, orgId: sponsor.organizationId, exp: Date.now() + 7 * 86400_000 });
  const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
  res.json({ token: sessionToken, sponsor: safeSponsor });
});

/** Resolve a sponsor analytics date range from query params.
 *  Returns null when explicit from/to are present but invalid.
 *  Falls back to the last `daysParam` (defaults to 30, capped at 365). */
function resolveSponsorRange(
  fromParam: string | undefined,
  toParam: string | undefined,
  daysParam: string | undefined,
): { since: Date; until: Date; days: number } | null {
  if (fromParam && toParam) {
    const fromDate = new Date(fromParam);
    const toDate = new Date(toParam);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) || fromDate > toDate) return null;
    const since = fromDate;
    const until = new Date(toDate.getTime() + 86400_000 - 1);
    const days = Math.max(1, Math.round((until.getTime() - since.getTime()) / 86400_000));
    return { since, until, days };
  }
  const days = Math.min(365, Math.max(1, parseInt(daysParam ?? "30") || 30));
  return { since: new Date(Date.now() - days * 86400_000), until: new Date(), days };
}

/** Run all sponsor analytics queries for a given date range and shape the
 *  result the same way the /me endpoint always has. */
async function computeSponsorAnalytics(
  sponsorId: number,
  range: { since: Date; until: Date; days: number },
) {
  const rangeWhere = and(
    gte(sponsorEventsTable.recordedAt, range.since),
    sql`${sponsorEventsTable.recordedAt} <= ${range.until.toISOString()}`,
  );

  const [analyticsTotals, analyticsBySource, analyticsByTournament, analyticsBySlot, analyticsByAdCampaign, analyticsByDaySlot] = await Promise.all([
    db.select({ eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable)
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), rangeWhere))
      .groupBy(sponsorEventsTable.eventType),

    db.select({ source: sponsorEventsTable.source, eventType: sponsorEventsTable.eventType, total: count() })
      .from(sponsorEventsTable)
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), rangeWhere))
      .groupBy(sponsorEventsTable.source, sponsorEventsTable.eventType),

    db.select({
      tournamentId: sponsorEventsTable.tournamentId,
      tournamentName: tournamentsTable.name,
      eventType: sponsorEventsTable.eventType,
      total: count(),
    })
      .from(sponsorEventsTable)
      .leftJoin(tournamentsTable, eq(sponsorEventsTable.tournamentId, tournamentsTable.id))
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), rangeWhere))
      .groupBy(sponsorEventsTable.tournamentId, tournamentsTable.name, sponsorEventsTable.eventType),

    db.select({
      slotKey: sponsorEventsTable.slotKey,
      eventType: sponsorEventsTable.eventType,
      total: count(),
    })
      .from(sponsorEventsTable)
      .where(and(
        eq(sponsorEventsTable.sponsorId, sponsorId),
        rangeWhere,
        sql`${sponsorEventsTable.slotKey} is not null`,
      ))
      .groupBy(sponsorEventsTable.slotKey, sponsorEventsTable.eventType),

    db.select({
      campaignId: sponsorEventsTable.campaignId,
      campaignName: adCampaignsTable.name,
      slotKey: adSlotsTable.slotKey,
      slotName: adSlotsTable.name,
      creativeId: sponsorEventsTable.creativeId,
      creativeName: adCreativesTable.name,
      eventType: sponsorEventsTable.eventType,
      total: count(),
    })
      .from(sponsorEventsTable)
      .innerJoin(adCampaignsTable, eq(sponsorEventsTable.campaignId, adCampaignsTable.id))
      .innerJoin(adSlotsTable, eq(adCampaignsTable.slotId, adSlotsTable.id))
      .innerJoin(adCreativesTable, eq(sponsorEventsTable.creativeId, adCreativesTable.id))
      .where(and(eq(sponsorEventsTable.sponsorId, sponsorId), rangeWhere))
      .groupBy(
        sponsorEventsTable.campaignId,
        adCampaignsTable.name,
        adSlotsTable.slotKey,
        adSlotsTable.name,
        sponsorEventsTable.creativeId,
        adCreativesTable.name,
        sponsorEventsTable.eventType,
      ),

    db.select({
      day: sql<string>`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      slotKey: sponsorEventsTable.slotKey,
      eventType: sponsorEventsTable.eventType,
      total: count(),
    })
      .from(sponsorEventsTable)
      .where(and(
        eq(sponsorEventsTable.sponsorId, sponsorId),
        rangeWhere,
        sql`${sponsorEventsTable.slotKey} is not null`,
      ))
      .groupBy(
        sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        sponsorEventsTable.slotKey,
        sponsorEventsTable.eventType,
      )
      .orderBy(sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),
  ]);

  const impressions = Number(analyticsTotals.find(r => r.eventType === "impression")?.total ?? 0);
  const clicks = Number(analyticsTotals.find(r => r.eventType === "click")?.total ?? 0);
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(1)) : 0,
    days: range.days,
    from: range.since.toISOString().slice(0, 10),
    to: range.until.toISOString().slice(0, 10),
    bySource: analyticsBySource.map(r => ({ source: r.source, eventType: r.eventType, total: Number(r.total) })),
    byTournament: analyticsByTournament.map(r => ({
      tournamentId: r.tournamentId,
      tournamentName: r.tournamentName,
      eventType: r.eventType,
      total: Number(r.total),
    })),
    bySlot: analyticsBySlot.map(r => ({
      slotKey: r.slotKey,
      eventType: r.eventType,
      total: Number(r.total),
    })),
    byDaySlot: analyticsByDaySlot.map(r => ({
      day: r.day,
      slotKey: r.slotKey,
      eventType: r.eventType,
      total: Number(r.total),
    })),
    byAdCampaign: analyticsByAdCampaign.map(r => ({
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      slotKey: r.slotKey,
      slotName: r.slotName,
      creativeId: r.creativeId,
      creativeName: r.creativeName,
      eventType: r.eventType,
      total: Number(r.total),
    })),
  };
}

// GET /sponsor-portal/me — validate sponsor token and return sponsor data + analytics
sponsorPortalRouter.get("/me", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { { res.status(401).json({ error: "No token provided" }); return; } }

  const token = auth.slice(7);
  try {
    const payload = verifySponsorToken(token);
    if (!payload) { { res.status(401).json({ error: "Invalid or expired token" }); return; } }
    const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, payload.sponsorId));
    if (!sponsor) { { res.status(404).json({ error: "Sponsor not found" }); return; } }

    // Resolve the analytics date range. Defaults to last 30 days, preserves
    // backwards-compat with no params. Supports ?days=N or ?from=YYYY-MM-DD&to=YYYY-MM-DD.
    const primary = resolveSponsorRange(req.query.from as string | undefined, req.query.to as string | undefined, req.query.days as string | undefined);
    if (!primary) { { res.status(400).json({ error: "Invalid date range" }); return; } }

    // Optional comparison range. Supports ?compareFrom/compareTo, or
    // ?compare=previous to auto-compute the immediately preceding period of
    // equal length to the primary range.
    let comparisonRange: { since: Date; until: Date; days: number } | null = null;
    if (req.query.compareFrom && req.query.compareTo) {
      const cmp = resolveSponsorRange(req.query.compareFrom as string, req.query.compareTo as string, undefined);
      if (!cmp) { { res.status(400).json({ error: "Invalid comparison range" }); return; } }
      comparisonRange = cmp;
    } else if (req.query.compare === "previous") {
      const span = primary.until.getTime() - primary.since.getTime();
      const cmpUntil = new Date(primary.since.getTime() - 1);
      const cmpSince = new Date(cmpUntil.getTime() - span);
      comparisonRange = { since: cmpSince, until: cmpUntil, days: primary.days };
    }

    const [assignments, invoices, primaryAnalytics, comparisonAnalytics] = await Promise.all([
      db.select({
        id: sponsorshipAssignmentsTable.id,
        assignmentType: sponsorshipAssignmentsTable.assignmentType,
        holeNumber: sponsorshipAssignmentsTable.holeNumber,
        tournamentId: sponsorshipAssignmentsTable.tournamentId,
        tournamentName: tournamentsTable.name,
        packageId: sponsorshipAssignmentsTable.packageId,
        packageName: sponsorshipPackagesTable.name,
      })
        .from(sponsorshipAssignmentsTable)
        .leftJoin(tournamentsTable, eq(sponsorshipAssignmentsTable.tournamentId, tournamentsTable.id))
        .leftJoin(sponsorshipPackagesTable, eq(sponsorshipAssignmentsTable.packageId, sponsorshipPackagesTable.id))
        .where(eq(sponsorshipAssignmentsTable.sponsorId, payload.sponsorId)),

      db.select({
        id: sponsorInvoicesTable.id,
        invoiceNumber: sponsorInvoicesTable.invoiceNumber,
        amount: sponsorInvoicesTable.amount,
        currency: sponsorInvoicesTable.currency,
        paymentStatus: sponsorInvoicesTable.paymentStatus,
        razorpayPaymentLinkUrl: sponsorInvoicesTable.razorpayPaymentLinkUrl,
        dueDate: sponsorInvoicesTable.dueDate,
        paidAt: sponsorInvoicesTable.paidAt,
        createdAt: sponsorInvoicesTable.createdAt,
      }).from(sponsorInvoicesTable).where(eq(sponsorInvoicesTable.sponsorId, payload.sponsorId)).orderBy(desc(sponsorInvoicesTable.createdAt)),

      computeSponsorAnalytics(payload.sponsorId, primary),
      comparisonRange ? computeSponsorAnalytics(payload.sponsorId, comparisonRange) : Promise.resolve(null),
    ]);

    const { portalPasswordHash, portalToken, portalTokenExpiry, ...safeSponsor } = sponsor;
    res.json({
      sponsor: safeSponsor,
      assignments,
      invoices,
      analytics: primaryAnalytics,
      comparison: comparisonAnalytics,
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

// PUT /sponsor-portal/upload-asset — submit logo or banner for pending approval
sponsorPortalRouter.put("/upload-asset", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { { res.status(401).json({ error: "No token provided" }); return; } }

  const token = auth.slice(7);
  const payload = verifySponsorToken(token);
  if (!payload) { { res.status(401).json({ error: "Invalid or expired token" }); return; } }

  const { assetType, url } = req.body;
  if (!url) { { res.status(400).json({ error: "url is required" }); return; } }

  if (assetType === "banner") {
    await db.update(sponsorsTable).set({ pendingBannerUrl: url, assetRejectionFeedback: null, updatedAt: new Date() }).where(eq(sponsorsTable.id, payload.sponsorId));
  } else {
    await db.update(sponsorsTable).set({ pendingLogoUrl: url, assetRejectionFeedback: null, updatedAt: new Date() }).where(eq(sponsorsTable.id, payload.sponsorId));
  }
  res.json({ ok: true, status: "pending_approval" });
});

// PUT /sponsor-portal/logo — sponsor updates their own logo (legacy, now stores as pending)
sponsorPortalRouter.put("/logo", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { { res.status(401).json({ error: "No token provided" }); return; } }

  const token = auth.slice(7);
  const payload = verifySponsorToken(token);
  if (!payload) { { res.status(401).json({ error: "Invalid or expired token" }); return; } }

  const { logoUrl } = req.body;
  if (!logoUrl) { { res.status(400).json({ error: "logoUrl is required" }); return; } }

  await db.update(sponsorsTable).set({ pendingLogoUrl: logoUrl, assetRejectionFeedback: null, updatedAt: new Date() }).where(eq(sponsorsTable.id, payload.sponsorId));
  res.json({ ok: true, status: "pending_approval" });
});

// GET /sponsor-portal/badge/:tournamentId — co-branded SVG badge download
sponsorPortalRouter.get("/badge/:tournamentId", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { { res.status(401).json({ error: "No token provided" }); return; } }

  const token = auth.slice(7);
  const payload = verifySponsorToken(token);
  if (!payload) { { res.status(401).json({ error: "Invalid or expired token" }); return; } }

  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  // Verify the tournament belongs to the sponsor's org
  const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, payload.orgId)));
  if (!tournament) { { res.status(403).json({ error: "Tournament not found or not accessible" }); return; } }

  // Verify the sponsor has an assignment for this tournament
  const [assignment] = await db.select({ id: sponsorshipAssignmentsTable.id })
    .from(sponsorshipAssignmentsTable)
    .where(and(
      eq(sponsorshipAssignmentsTable.sponsorId, payload.sponsorId),
      eq(sponsorshipAssignmentsTable.tournamentId, tournamentId),
    ));
  if (!assignment) { { res.status(403).json({ error: "Sponsor is not assigned to this tournament" }); return; } }

  const [sponsor, org] = await Promise.all([
    db.select({ name: sponsorsTable.name, logoUrl: sponsorsTable.logoUrl })
      .from(sponsorsTable).where(eq(sponsorsTable.id, payload.sponsorId)).then(r => r[0]),
    db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
      .from(organizationsTable).where(eq(organizationsTable.id, payload.orgId)).then(r => r[0]),
  ]);

  const sponsorName = sponsor?.name ?? "Sponsor";
  const tournamentName = tournament.name ?? "Golf Tournament";
  const orgName = org?.name ?? "KHARAGOLF";

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Logo sections — render <image> when URL available, fallback to initials box
  const sponsorLogoBlock = sponsor?.logoUrl
    ? `<image href="${esc(sponsor.logoUrl)}" x="20" y="20" width="80" height="80" preserveAspectRatio="xMidYMid meet" clip-path="url(#leftClip)"/>`
    : `<rect x="20" y="20" width="80" height="80" rx="8" fill="#1e4d2b"/><text x="60" y="70" font-family="Georgia,serif" font-size="28" fill="#f59e0b" text-anchor="middle" dominant-baseline="middle">${esc(sponsorName.charAt(0))}</text>`;
  const orgLogoBlock = org?.logoUrl
    ? `<image href="${esc(org.logoUrl)}" x="500" y="20" width="80" height="80" preserveAspectRatio="xMidYMid meet" clip-path="url(#rightClip)"/>`
    : `<rect x="500" y="20" width="80" height="80" rx="8" fill="#1e4d2b"/><text x="540" y="70" font-family="Georgia,serif" font-size="28" fill="#f59e0b" text-anchor="middle" dominant-baseline="middle">${esc(orgName.charAt(0))}</text>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="200" viewBox="0 0 600 200">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f2417;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#1e4d2b;stop-opacity:1" />
    </linearGradient>
    <clipPath id="leftClip"><rect x="20" y="20" width="80" height="80" rx="8"/></clipPath>
    <clipPath id="rightClip"><rect x="500" y="20" width="80" height="80" rx="8"/></clipPath>
  </defs>
  <rect width="600" height="200" fill="url(#bg)" rx="16"/>
  <rect x="1" y="1" width="598" height="198" fill="none" stroke="#f59e0b" stroke-width="2" rx="15" stroke-dasharray="8,4" opacity="0.6"/>
  ${sponsorLogoBlock}
  ${orgLogoBlock}
  <text x="300" y="48" font-family="Georgia,serif" font-size="13" fill="#f59e0b" text-anchor="middle" letter-spacing="3" opacity="0.9">OFFICIAL SPONSOR</text>
  <line x1="120" y1="60" x2="480" y2="60" stroke="#f59e0b" stroke-width="0.5" opacity="0.4"/>
  <text x="300" y="100" font-family="Georgia,serif" font-size="24" fill="#ffffff" text-anchor="middle" font-weight="bold">${esc(sponsorName)}</text>
  <text x="300" y="128" font-family="Arial,sans-serif" font-size="13" fill="#86efac" text-anchor="middle">Official Sponsor of ${esc(tournamentName)}</text>
  <line x1="120" y1="145" x2="480" y2="145" stroke="#f59e0b" stroke-width="0.5" opacity="0.4"/>
  <text x="300" y="170" font-family="Arial,sans-serif" font-size="11" fill="#6ee7b7" text-anchor="middle" opacity="0.8">${esc(orgName)} · Powered by KHARAGOLF</text>
</svg>`;

  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Content-Disposition", `attachment; filename="sponsor_badge_${payload.sponsorId}.svg"`);
  res.send(svg);
});

// GET /sponsor-portal/impressions — download impressions CSV
sponsorPortalRouter.get("/impressions", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { { res.status(401).json({ error: "No token provided" }); return; } }

  const token = auth.slice(7);
  try {
    const payload = verifySponsorToken(token);
    if (!payload) { { res.status(401).json({ error: "Invalid or expired token" }); return; } }

    const primary = resolveSponsorRange(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
      req.query.days as string | undefined,
    );
    if (!primary) { { res.status(400).json({ error: "Invalid date range" }); return; } }
    const { since, until, days } = primary;

    // Optional comparison range — same semantics as /sponsor-portal/me.
    let comparisonRange: { since: Date; until: Date; days: number } | null = null;
    if (req.query.compareFrom && req.query.compareTo) {
      const cmp = resolveSponsorRange(req.query.compareFrom as string, req.query.compareTo as string, undefined);
      if (!cmp) { { res.status(400).json({ error: "Invalid comparison range" }); return; } }
      comparisonRange = cmp;
    } else if (req.query.compare === "previous") {
      const span = primary.until.getTime() - primary.since.getTime();
      const cmpUntil = new Date(primary.since.getTime() - 1);
      const cmpSince = new Date(cmpUntil.getTime() - span);
      comparisonRange = { since: cmpSince, until: cmpUntil, days: primary.days };
    }

    const rangeWhere = and(
      gte(sponsorEventsTable.recordedAt, since),
      sql`${sponsorEventsTable.recordedAt} <= ${until.toISOString()}`,
    );
    const comparisonSlotRowsPromise = comparisonRange
      ? db.select({
          slotKey: sponsorEventsTable.slotKey,
          eventType: sponsorEventsTable.eventType,
          total: count(),
        })
          .from(sponsorEventsTable)
          .where(and(
            eq(sponsorEventsTable.sponsorId, payload.sponsorId),
            gte(sponsorEventsTable.recordedAt, comparisonRange.since),
            sql`${sponsorEventsTable.recordedAt} <= ${comparisonRange.until.toISOString()}`,
          ))
          .groupBy(sponsorEventsTable.slotKey, sponsorEventsTable.eventType)
      : Promise.resolve([] as Array<{ slotKey: string | null; eventType: string; total: number }>);

    const comparisonDaySlotRowsPromise = comparisonRange
      ? db.select({
          day: sql<string>`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          slotKey: sponsorEventsTable.slotKey,
          eventType: sponsorEventsTable.eventType,
          total: count(),
        })
          .from(sponsorEventsTable)
          .where(and(
            eq(sponsorEventsTable.sponsorId, payload.sponsorId),
            gte(sponsorEventsTable.recordedAt, comparisonRange.since),
            sql`${sponsorEventsTable.recordedAt} <= ${comparisonRange.until.toISOString()}`,
          ))
          .groupBy(
            sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
            sponsorEventsTable.slotKey,
            sponsorEventsTable.eventType,
          )
      : Promise.resolve([] as Array<{ day: string; slotKey: string | null; eventType: string; total: number }>);

    // Per-tournament aggregation for the comparison range — mirrors the
    // primary tournamentRows query below so we can build a side-by-side
    // summary section in the CSV when a comparison range is active.
    const comparisonTournamentRowsPromise = comparisonRange
      ? db.select({
          tournamentId: sponsorEventsTable.tournamentId,
          tournamentName: tournamentsTable.name,
          eventType: sponsorEventsTable.eventType,
          total: count(),
        })
          .from(sponsorEventsTable)
          .leftJoin(tournamentsTable, eq(sponsorEventsTable.tournamentId, tournamentsTable.id))
          .where(and(
            eq(sponsorEventsTable.sponsorId, payload.sponsorId),
            gte(sponsorEventsTable.recordedAt, comparisonRange.since),
            sql`${sponsorEventsTable.recordedAt} <= ${comparisonRange.until.toISOString()}`,
          ))
          .groupBy(sponsorEventsTable.tournamentId, tournamentsTable.name, sponsorEventsTable.eventType)
      : Promise.resolve([] as Array<{ tournamentId: number | null; tournamentName: string | null; eventType: string; total: number }>);

    const [events, slotRows, comparisonSlotRows, comparisonDaySlotRows, tournamentRows, comparisonTournamentRows] = await Promise.all([
      db.select({
        day: sql<string>`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        eventType: sponsorEventsTable.eventType,
        source: sponsorEventsTable.source,
        slotKey: sponsorEventsTable.slotKey,
        campaignName: adCampaignsTable.name,
        creativeName: adCreativesTable.name,
        total: count(),
      })
        .from(sponsorEventsTable)
        .leftJoin(adCampaignsTable, eq(sponsorEventsTable.campaignId, adCampaignsTable.id))
        .leftJoin(adCreativesTable, eq(sponsorEventsTable.creativeId, adCreativesTable.id))
        .where(and(eq(sponsorEventsTable.sponsorId, payload.sponsorId), rangeWhere))
        .groupBy(
          sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          sponsorEventsTable.eventType,
          sponsorEventsTable.source,
          sponsorEventsTable.slotKey,
          adCampaignsTable.name,
          adCreativesTable.name,
        )
        .orderBy(sql`to_char(${sponsorEventsTable.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),

      db.select({
        slotKey: sponsorEventsTable.slotKey,
        eventType: sponsorEventsTable.eventType,
        total: count(),
      })
        .from(sponsorEventsTable)
        .where(and(eq(sponsorEventsTable.sponsorId, payload.sponsorId), rangeWhere))
        .groupBy(sponsorEventsTable.slotKey, sponsorEventsTable.eventType),

      comparisonSlotRowsPromise,

      comparisonDaySlotRowsPromise,

      // Per-tournament aggregation for the primary range — fuels the
      // Per-Tournament Summary CSV section so sponsors can paste
      // tournament-level totals straight into spreadsheets.
      db.select({
        tournamentId: sponsorEventsTable.tournamentId,
        tournamentName: tournamentsTable.name,
        eventType: sponsorEventsTable.eventType,
        total: count(),
      })
        .from(sponsorEventsTable)
        .leftJoin(tournamentsTable, eq(sponsorEventsTable.tournamentId, tournamentsTable.id))
        .where(and(eq(sponsorEventsTable.sponsorId, payload.sponsorId), rangeWhere))
        .groupBy(sponsorEventsTable.tournamentId, tournamentsTable.name, sponsorEventsTable.eventType),

      comparisonTournamentRowsPromise,
    ]);

    const escape = (v: string | null | undefined) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    type SlotAgg = { impressions: number; clicks: number };
    const slotMap = new Map<string, SlotAgg>();
    for (const r of slotRows) {
      if (!r.slotKey) continue;
      const agg = slotMap.get(r.slotKey) ?? { impressions: 0, clicks: 0 };
      if (r.eventType === "impression") agg.impressions += Number(r.total);
      else if (r.eventType === "click") agg.clicks += Number(r.total);
      slotMap.set(r.slotKey, agg);
    }
    const comparisonSlotMap = new Map<string, SlotAgg>();
    for (const r of comparisonSlotRows) {
      if (!r.slotKey) continue;
      const agg = comparisonSlotMap.get(r.slotKey) ?? { impressions: 0, clicks: 0 };
      if (r.eventType === "impression") agg.impressions += Number(r.total);
      else if (r.eventType === "click") agg.clicks += Number(r.total);
      comparisonSlotMap.set(r.slotKey, agg);
    }

    const formatPctChange = (current: number, previous: number): string => {
      if (previous === 0) return current === 0 ? "no change" : "new";
      const pct = ((current - previous) / previous) * 100;
      const sign = pct > 0 ? "+" : "";
      return `${sign}${pct.toFixed(1)}%`;
    };

    const allSlotKeys = new Set<string>([...slotMap.keys(), ...comparisonSlotMap.keys()]);
    const slotSummary = Array.from(allSlotKeys)
      .map(slotKey => {
        const agg = slotMap.get(slotKey) ?? { impressions: 0, clicks: 0 };
        const cmp = comparisonSlotMap.get(slotKey) ?? { impressions: 0, clicks: 0 };
        return {
          slotKey,
          impressions: agg.impressions,
          clicks: agg.clicks,
          ctr: agg.impressions > 0 ? Number(((agg.clicks / agg.impressions) * 100).toFixed(1)) : 0,
          comparisonImpressions: cmp.impressions,
          comparisonClicks: cmp.clicks,
        };
      })
      .sort((a, b) => b.impressions - a.impressions || b.comparisonImpressions - a.comparisonImpressions);

    const lines: string[] = [
      "Date,Event Type,Source,Slot,Campaign,Creative,Count",
      ...events.map(e => [
        e.day, e.eventType, e.source, e.slotKey ?? "", e.campaignName ?? "", e.creativeName ?? "", e.total,
      ].map(c => escape(typeof c === "number" ? String(c) : c)).join(",")),
    ];
    if (slotSummary.length > 0) {
      lines.push("");
      const primaryRangeLabel = `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`;
      if (comparisonRange) {
        const cmpRangeLabel = `${comparisonRange.since.toISOString().slice(0, 10)} to ${comparisonRange.until.toISOString().slice(0, 10)}`;
        lines.push(`Per-Slot Summary (${primaryRangeLabel} vs ${cmpRangeLabel})`);
        lines.push("Slot,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,% Change");
        for (const s of slotSummary) {
          lines.push([
            s.slotKey,
            String(s.impressions),
            String(s.clicks),
            s.ctr.toFixed(1),
            String(s.comparisonImpressions),
            String(s.comparisonClicks),
            formatPctChange(s.impressions, s.comparisonImpressions),
          ].map(escape).join(","));
        }
      } else {
        lines.push(`Per-Slot Summary (last ${days} days)`);
        lines.push("Slot,Impressions,Clicks,CTR (%)");
        for (const s of slotSummary) {
          lines.push([s.slotKey, String(s.impressions), String(s.clicks), s.ctr.toFixed(1)]
            .map(escape).join(","));
        }
      }
    }

    // Per-tournament summary so sponsors can paste tournament-level totals
    // straight into spreadsheets and decks. Mirrors the on-screen
    // "Performance by Tournament" table: when a comparison range is active
    // we emit prior-period absolutes and a signed % change column (with
    // "new" when the prior period had zero impressions).
    type TournamentAgg = {
      key: string;
      tournamentId: number | null;
      tournamentName: string | null;
      impressions: number;
      clicks: number;
    };
    const tournamentKeyOf = (id: number | null, name: string | null) =>
      id != null ? `t:${id}` : `n:${name ?? ""}`;
    const aggregateTournamentRows = (
      rows: Array<{ tournamentId: number | null; tournamentName: string | null; eventType: string; total: number }>,
    ): Map<string, TournamentAgg> => {
      const map = new Map<string, TournamentAgg>();
      for (const r of rows) {
        const key = tournamentKeyOf(r.tournamentId, r.tournamentName);
        const agg = map.get(key) ?? {
          key,
          tournamentId: r.tournamentId,
          tournamentName: r.tournamentName,
          impressions: 0,
          clicks: 0,
        };
        if (r.eventType === "impression") agg.impressions += Number(r.total);
        else if (r.eventType === "click") agg.clicks += Number(r.total);
        map.set(key, agg);
      }
      return map;
    };
    const tournamentMap = aggregateTournamentRows(tournamentRows);
    const comparisonTournamentMap = aggregateTournamentRows(comparisonTournamentRows);
    const allTournamentKeys = new Set<string>([...tournamentMap.keys(), ...comparisonTournamentMap.keys()]);
    // Render "—" for null tournament names so the CSV mirrors the on-screen
    // table; this happens for legacy events that weren't tagged with a
    // tournament (or for events tagged with a tournament that's since been
    // deleted, which the LEFT JOIN surfaces as null).
    const tournamentLabel = (agg: TournamentAgg) => agg.tournamentName ?? "—";
    const tournamentSummary = Array.from(allTournamentKeys)
      .map(key => {
        const agg = tournamentMap.get(key);
        const cmp = comparisonTournamentMap.get(key);
        // Prefer the primary period's identity, falling back to the
        // comparison period when the tournament only had activity then.
        const id = (agg ?? cmp!).tournamentId;
        const name = (agg ?? cmp!).tournamentName;
        const cur = agg ?? { key, tournamentId: id, tournamentName: name, impressions: 0, clicks: 0 };
        const prev = cmp ?? { key, tournamentId: id, tournamentName: name, impressions: 0, clicks: 0 };
        return {
          key,
          tournamentId: id,
          tournamentName: name,
          impressions: cur.impressions,
          clicks: cur.clicks,
          ctr: cur.impressions > 0 ? Number(((cur.clicks / cur.impressions) * 100).toFixed(1)) : 0,
          comparisonImpressions: prev.impressions,
          comparisonClicks: prev.clicks,
        };
      })
      .sort((a, b) => b.impressions - a.impressions || b.comparisonImpressions - a.comparisonImpressions);
    if (tournamentSummary.length > 0) {
      lines.push("");
      const primaryRangeLabel = `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`;
      if (comparisonRange) {
        const cmpRangeLabel = `${comparisonRange.since.toISOString().slice(0, 10)} to ${comparisonRange.until.toISOString().slice(0, 10)}`;
        lines.push(`Per-Tournament Summary (${primaryRangeLabel} vs ${cmpRangeLabel})`);
        lines.push("Tournament,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,% Change");
        for (const t of tournamentSummary) {
          lines.push([
            tournamentLabel(t),
            String(t.impressions),
            String(t.clicks),
            t.ctr.toFixed(1),
            String(t.comparisonImpressions),
            String(t.comparisonClicks),
            formatPctChange(t.impressions, t.comparisonImpressions),
          ].map(escape).join(","));
        }
      } else {
        lines.push(`Per-Tournament Summary (last ${days} days)`);
        lines.push("Tournament,Impressions,Clicks,CTR (%)");
        for (const t of tournamentSummary) {
          lines.push([tournamentLabel(t), String(t.impressions), String(t.clicks), t.ctr.toFixed(1)]
            .map(escape).join(","));
        }
      }
    }

    // Per-day per-slot CTR trend so sponsors can chart slot performance over time.
    type DaySlotAgg = { day: string; slotKey: string; impressions: number; clicks: number };
    const daySlotMap = new Map<string, DaySlotAgg>();
    for (const e of events) {
      if (!e.slotKey) continue;
      const key = `${e.day}|${e.slotKey}`;
      const agg = daySlotMap.get(key) ?? { day: e.day, slotKey: e.slotKey, impressions: 0, clicks: 0 };
      if (e.eventType === "impression") agg.impressions += Number(e.total);
      else if (e.eventType === "click") agg.clicks += Number(e.total);
      daySlotMap.set(key, agg);
    }
    const comparisonDaySlotMap = new Map<string, DaySlotAgg>();
    for (const r of comparisonDaySlotRows) {
      if (!r.slotKey) continue;
      const key = `${r.day}|${r.slotKey}`;
      const agg = comparisonDaySlotMap.get(key) ?? { day: r.day, slotKey: r.slotKey, impressions: 0, clicks: 0 };
      if (r.eventType === "impression") agg.impressions += Number(r.total);
      else if (r.eventType === "click") agg.clicks += Number(r.total);
      comparisonDaySlotMap.set(key, agg);
    }
    const daySlotTrend = Array.from(daySlotMap.values())
      .sort((a, b) => (a.day === b.day ? a.slotKey.localeCompare(b.slotKey) : a.day.localeCompare(b.day)));
    if (daySlotTrend.length > 0 || comparisonDaySlotMap.size > 0) {
      lines.push("");
      const ctrPct = (impressions: number, clicks: number) =>
        impressions > 0 ? ((clicks / impressions) * 100).toFixed(1) : "0.0";
      if (comparisonRange) {
        const primaryRangeLabel = `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`;
        const cmpRangeLabel = `${comparisonRange.since.toISOString().slice(0, 10)} to ${comparisonRange.until.toISOString().slice(0, 10)}`;
        lines.push(`Per-Day Per-Slot CTR Trend (${primaryRangeLabel} vs ${cmpRangeLabel})`);
        lines.push("Date,Slot,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,Comparison CTR (%),% Change");
        const allKeys = new Set<string>([...daySlotMap.keys(), ...comparisonDaySlotMap.keys()]);
        const merged = Array.from(allKeys).map(key => {
          const [day, slotKey] = key.split("|");
          const cur = daySlotMap.get(key) ?? { day, slotKey, impressions: 0, clicks: 0 };
          const cmp = comparisonDaySlotMap.get(key) ?? { day, slotKey, impressions: 0, clicks: 0 };
          return { day, slotKey, cur, cmp };
        }).sort((a, b) => (a.day === b.day ? a.slotKey.localeCompare(b.slotKey) : a.day.localeCompare(b.day)));
        for (const r of merged) {
          lines.push([
            r.day,
            r.slotKey,
            String(r.cur.impressions),
            String(r.cur.clicks),
            ctrPct(r.cur.impressions, r.cur.clicks),
            String(r.cmp.impressions),
            String(r.cmp.clicks),
            ctrPct(r.cmp.impressions, r.cmp.clicks),
            formatPctChange(r.cur.impressions, r.cmp.impressions),
          ].map(escape).join(","));
        }
      } else {
        lines.push(`Per-Day Per-Slot CTR Trend (last ${days} days)`);
        lines.push("Date,Slot,Impressions,Clicks,CTR (%)");
        for (const r of daySlotTrend) {
          lines.push([r.day, r.slotKey, String(r.impressions), String(r.clicks), ctrPct(r.impressions, r.clicks)]
            .map(escape).join(","));
        }
      }
    }
    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="sponsor_impressions_${days}d.csv"`);
    res.send(csv);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});
