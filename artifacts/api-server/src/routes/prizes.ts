import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  prizeCategoriesTable, prizeAwardsTable, orgMembershipsTable, playersTable, organizationsTable, tournamentsTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { computeLeaderboard } from "../lib/realtime";
import { resolveOrgBranding } from "../lib/clubTheming";
import PDFDocument from "pdfkit";

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

// GET /organizations/:orgId/tournaments/:tournamentId/prizes
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const [tournament] = await db.select({ prizeDistributionStatus: tournamentsTable.prizeDistributionStatus })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  const categories = await db.select().from(prizeCategoriesTable)
    .where(eq(prizeCategoriesTable.tournamentId, tournamentId))
    .orderBy(asc(prizeCategoriesTable.displayOrder));

  const withAwards = await Promise.all(categories.map(async (cat) => {
    const awards = await db
      .select({
        id: prizeAwardsTable.id,
        playerName: prizeAwardsTable.playerName,
        playerId: prizeAwardsTable.playerId,
        awardAmount: prizeAwardsTable.awardAmount,
        awardCurrency: prizeAwardsTable.awardCurrency,
        notes: prizeAwardsTable.notes,
        awardedAt: prizeAwardsTable.awardedAt,
      })
      .from(prizeAwardsTable)
      .where(eq(prizeAwardsTable.prizeCategoryId, cat.id));
    return { ...cat, awards };
  }));

  res.json({ prizeDistributionStatus: tournament?.prizeDistributionStatus ?? null, categories: withAwards });
});

// POST /organizations/:orgId/tournaments/:tournamentId/prizes
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { name, description, prizeValue, currency, sponsorId, displayOrder } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [cat] = await db.insert(prizeCategoriesTable).values({
    tournamentId,
    name,
    description,
    prizeValue,
    currency: currency ?? "INR",
    sponsorId: sponsorId ?? null,
    displayOrder: displayOrder ?? 0,
  }).returning();

  res.status(201).json(cat);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/prizes/:prizeId
router.put("/:prizeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const prizeId = parseInt(String((req.params as Record<string, string>).prizeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { name, description, prizeValue, currency, sponsorId, displayOrder } = req.body;
  // Constrain update to (prizeId AND tournamentId) to prevent cross-tournament IDOR
  const [cat] = await db.update(prizeCategoriesTable)
    .set({ name, description, prizeValue, currency, sponsorId, displayOrder })
    .where(and(eq(prizeCategoriesTable.id, prizeId), eq(prizeCategoriesTable.tournamentId, tournamentId)))
    .returning();
  if (!cat) { { res.status(404).json({ error: "Prize category not found in this tournament" }); return; } }
  res.json(cat);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/prizes/:prizeId
router.delete("/:prizeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const prizeId = parseInt(String((req.params as Record<string, string>).prizeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;
  await db.delete(prizeCategoriesTable).where(and(eq(prizeCategoriesTable.id, prizeId), eq(prizeCategoriesTable.tournamentId, tournamentId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/prizes/:prizeId/award
router.post("/:prizeId/award", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const prizeId = parseInt(String((req.params as Record<string, string>).prizeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { playerId, playerName, notes } = req.body;
  if (!playerName) { { res.status(400).json({ error: "playerName is required" }); return; } }

  // Verify that the prize category belongs to this tournament (prevents cross-tournament IDOR)
  const [prizeCheck] = await db.select({ id: prizeCategoriesTable.id })
    .from(prizeCategoriesTable)
    .where(and(eq(prizeCategoriesTable.id, prizeId), eq(prizeCategoriesTable.tournamentId, tournamentId)));
  if (!prizeCheck) { { res.status(403).json({ error: "Prize category does not belong to this tournament" }); return; } }

  const [award] = await db.insert(prizeAwardsTable).values({
    prizeCategoryId: prizeId,
    tournamentId,
    playerId: playerId ?? null,
    playerName,
    notes,
  }).returning();

  res.status(201).json(award);
});

// GET /organizations/:orgId/tournaments/:tournamentId/prizes/:prizeId/award/:awardId/certificate
router.get("/:prizeId/award/:awardId/certificate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const awardId = parseInt(String((req.params as Record<string, string>).awardId));
  const prizeId = parseInt(String((req.params as Record<string, string>).prizeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  // Verify ownership chain: award → prizeCategory → tournament → org
  const [award] = await db.select().from(prizeAwardsTable)
    .where(and(eq(prizeAwardsTable.id, awardId), eq(prizeAwardsTable.prizeCategoryId, prizeId)));
  if (!award) { { res.status(404).json({ error: "Award not found" }); return; } }

  const [prizeCategory] = await db.select().from(prizeCategoriesTable)
    .where(and(eq(prizeCategoriesTable.id, prizeId), eq(prizeCategoriesTable.tournamentId, tournamentId)));
  if (!prizeCategory) { { res.status(403).json({ error: "Prize category does not belong to this tournament" }); return; } }

  const [[org], [tournament]] = await Promise.all([
    db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl }).from(organizationsTable).where(eq(organizationsTable.id, orgId)),
    db.select({ name: tournamentsTable.name, startDate: tournamentsTable.startDate }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId)),
  ]);

  // Task #1758 — prefer the saved club_theming row over the legacy
  // `organizations.logo_url` column so prize certificates carry the same
  // logo the admin most recently picked in the club-theming UI.
  const branded = await resolveOrgBranding(orgId, org ?? undefined);
  const certLogoUrl = branded.logoUrl ?? null;

  // Fetch org logo as a Buffer if available
  let logoBuffer: Buffer | null = null;
  if (certLogoUrl) {
    try {
      const imgRes = await fetch(certLogoUrl);
      if (imgRes.ok) logoBuffer = Buffer.from(await imgRes.arrayBuffer());
    } catch {
      // Non-fatal: render certificate without logo if fetch fails
    }
  }

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 60 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="certificate-${awardId}.pdf"`);
  doc.pipe(res);

  // Background + border
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#0a1628");
  doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60).stroke("#1e4d2b").lineWidth(3);

  // Org logo (if available) — centered at top
  const logoSize = 52;
  const logoX = (doc.page.width - logoSize) / 2;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, logoX, 52, { width: logoSize, height: logoSize, fit: [logoSize, logoSize], align: "center" });
    } catch {
      // Skip logo rendering if pdfkit cannot decode the image format
    }
  }

  // Header — org name as title + "CERTIFICATE OF ACHIEVEMENT" subtitle
  const orgLabel = org?.name ?? "KHARAGOLF";
  const headerY = logoBuffer ? 114 : 60;
  doc.fill("#22c55e").font("Helvetica-Bold").fontSize(22).text(orgLabel, 0, headerY, { align: "center" });
  doc.fill("#4ade80").font("Helvetica").fontSize(10).text("CERTIFICATE OF ACHIEVEMENT", 0, headerY + 30, { align: "center" });

  // All body positions are relative to the end of the header block
  const bodyStart = headerY + 48;

  // Recipient name
  doc.fill("#ffffff").font("Helvetica-Bold").fontSize(42).text(award.playerName, 0, bodyStart, { align: "center" });
  doc.fill("#9ca3af").font("Helvetica").fontSize(16).text("is proud recipient of", 0, bodyStart + 56, { align: "center" });

  // Prize name
  doc.fill("#22c55e").font("Helvetica-Bold").fontSize(28).text(prizeCategory?.name ?? "Prize", 0, bodyStart + 86, { align: "center" });

  // Tournament name
  if (tournament?.name) {
    doc.fill("#d1d5db").font("Helvetica").fontSize(14).text(tournament.name, 0, bodyStart + 128, { align: "center" });
  }

  // Divider line
  const midX = doc.page.width / 2;
  const dividerY = bodyStart + 154;
  doc.moveTo(midX - 100, dividerY).lineTo(midX + 100, dividerY).stroke("#374151");

  // Date
  const awardDate = new Date(award.awardedAt).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  const tournamentDate = tournament?.startDate
    ? new Date(tournament.startDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const dateLabel = tournamentDate ? `${tournamentDate}  ·  Awarded ${awardDate}` : `Awarded ${awardDate}`;
  doc.fill("#6b7280").font("Helvetica").fontSize(11).text(dateLabel, 0, dividerY + 14, { align: "center" });

  doc.end();
});

// ─── PAYOUT CALCULATOR ────────────────────────────────────────────────────────

// PUT /organizations/:orgId/tournaments/:tournamentId/prizes/payout-structure
router.put("/payout-structure", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { payoutStructure } = req.body;
  if (!Array.isArray(payoutStructure)) { { res.status(400).json({ error: "payoutStructure must be an array" }); return; } }
  const totalPct = payoutStructure.reduce((s: number, r: { percentage: number }) => s + (r.percentage ?? 0), 0);
  if (Math.abs(totalPct - 100) > 0.01 && payoutStructure.length > 0) {
    res.status(400).json({ error: `Percentages must sum to 100 (currently ${totalPct.toFixed(1)}%)` }); return;
  }

  const typedPayoutStructure: { position: number; percentage: number }[] = payoutStructure;
  await db.update(tournamentsTable).set({ payoutStructure: typedPayoutStructure }).where(eq(tournamentsTable.id, tournamentId));
  res.json({ ok: true, payoutStructure });
});

// POST /organizations/:orgId/tournaments/:tournamentId/prizes/calculate-payouts
// Returns a preview array without committing anything to DB
router.post("/calculate-payouts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const payoutStructure = tournament.payoutStructure as { position: number; percentage: number }[] | null;
  if (!payoutStructure || payoutStructure.length === 0) {
    res.status(400).json({ error: "No payout structure defined. Please save a payout structure first." }); return;
  }

  // Total prize pool = sum of all paid entry fees
  const players = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
    paymentStatus: playersTable.paymentStatus,
    entryFee: tournamentsTable.entryFee,
    currency: tournamentsTable.currency,
  }).from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(eq(playersTable.tournamentId, tournamentId));

  const currency = tournament.currency ?? "INR";
  const feePerPlayer = parseFloat(tournament.entryFee ?? "0");
  const paidCount = players.filter(p => p.paymentStatus === "paid" || (p.paymentStatus as string) === "free").length;
  const prizePool = feePerPlayer * paidCount;

  // Get leaderboard for positions
  const leaderboard = await computeLeaderboard(tournamentId);
  if (!leaderboard) { { res.status(404).json({ error: "Leaderboard not found" }); return; } }

  const grossEntries = leaderboard.entries.filter(e => !e.dns && e.position > 0);

  const preview = payoutStructure.map((tier) => {
    const entry = grossEntries.find(e => e.position === tier.position);
    const amount = parseFloat(((tier.percentage / 100) * prizePool).toFixed(2));
    return {
      position: tier.position,
      percentage: tier.percentage,
      grossAmount: amount,
      currency,
      playerId: entry?.playerId ?? null,
      playerName: entry?.playerName ?? null,
      grossScore: entry?.grossScore ?? null,
    };
  });

  res.json({ prizePool, currency, paidCount, preview });
});

// POST /organizations/:orgId/tournaments/:tournamentId/prizes/auto-assign-awards
router.post("/auto-assign-awards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const { preview, prizeCategoryId, forceReassign } = req.body;
  if (!Array.isArray(preview) || preview.length === 0) {
    res.status(400).json({ error: "preview array is required" }); return;
  }

  // Guard against accidental re-assignment unless forceReassign is explicitly set
  const [tCheck] = await db.select({ prizeDistributionStatus: tournamentsTable.prizeDistributionStatus })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (tCheck?.prizeDistributionStatus === "distributed" && !forceReassign) {
    res.status(409).json({
      error: "Prizes have already been distributed for this tournament. Pass forceReassign: true to override.",
      distributionStatus: "distributed",
    }); return;
  }

  // Validate caller-supplied prizeCategoryId ownership BEFORE entering transaction
  if (prizeCategoryId) {
    const [catCheck] = await db.select({ id: prizeCategoriesTable.id }).from(prizeCategoriesTable)
      .where(and(eq(prizeCategoriesTable.id, prizeCategoryId), eq(prizeCategoriesTable.tournamentId, tournamentId)));
    if (!catCheck) { { res.status(403).json({ error: "prizeCategoryId does not belong to this tournament" }); return; } }
  }

  // Pre-validate that preview contains at least one eligible row before entering the transaction
  // This avoids deleting prior awards in a force-reassign only to find no new ones qualify
  const eligibleRows = preview.filter((item: { playerName?: string }) => item.playerName);
  if (eligibleRows.length === 0) {
    res.status(400).json({ error: "No eligible players found in preview — prizeDistributionStatus was not changed." }); return;
  }

  // Wrap category resolution + delete + insert + status update in a single transaction for atomicity
  const created: (typeof prizeAwardsTable.$inferSelect)[] = await db.transaction(async (tx) => {
    // Create or find a "Prize Payout" category
    let catId: number = prizeCategoryId;
    if (!catId) {
      const existing = await tx.select({ id: prizeCategoriesTable.id }).from(prizeCategoriesTable)
        .where(and(eq(prizeCategoriesTable.tournamentId, tournamentId), eq(prizeCategoriesTable.name, "Prize Payout")));
      if (existing[0]) {
        catId = existing[0].id;
      } else {
        const [cat] = await tx.insert(prizeCategoriesTable).values({
          tournamentId,
          name: "Prize Payout",
          description: "Auto-assigned prize payouts",
          displayOrder: 999,
        }).returning();
        catId = cat.id;
      }
    }

    // When force re-assigning, delete prior auto-payout awards to prevent duplicates
    if (forceReassign && catId) {
      await tx.delete(prizeAwardsTable)
        .where(and(eq(prizeAwardsTable.tournamentId, tournamentId), eq(prizeAwardsTable.prizeCategoryId, catId)));
    }

    const txCreated: (typeof prizeAwardsTable.$inferSelect)[] = [];
    for (const item of preview) {
      if (!item.playerName) continue;
      const [award] = await tx.insert(prizeAwardsTable).values({
        prizeCategoryId: catId,
        tournamentId,
        playerId: item.playerId ?? null,
        playerName: item.playerName,
        awardAmount: String(item.grossAmount),
        awardCurrency: item.currency,
        notes: `Position ${item.position} · ${item.percentage}%`,
      }).returning();
      txCreated.push(award);
    }

    // Mark tournament prize distribution as distributed (inside transaction)
    await tx.update(tournamentsTable)
      .set({ prizeDistributionStatus: "distributed" })
      .where(eq(tournamentsTable.id, tournamentId));

    return txCreated;
  });

  res.status(201).json({ ok: true, count: created.length, awards: created, distributionStatus: "distributed" });
});

// GET /organizations/:orgId/tournaments/:tournamentId/prizes/export-payouts.csv
router.get("/export-payouts.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireTournamentInOrg(res, tournamentId, orgId)) return;

  const [tournament] = await db.select({ name: tournamentsTable.name, currency: tournamentsTable.currency }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  const awards = await db.select({
    playerName: prizeAwardsTable.playerName,
    awardAmount: prizeAwardsTable.awardAmount,
    awardCurrency: prizeAwardsTable.awardCurrency,
    notes: prizeAwardsTable.notes,
    awardedAt: prizeAwardsTable.awardedAt,
    categoryName: prizeCategoriesTable.name,
    categoryValue: prizeCategoriesTable.prizeValue,
    categoryCurrency: prizeCategoriesTable.currency,
  }).from(prizeAwardsTable)
    .innerJoin(prizeCategoriesTable, eq(prizeAwardsTable.prizeCategoryId, prizeCategoriesTable.id))
    .where(eq(prizeAwardsTable.tournamentId, tournamentId))
    .orderBy(asc(prizeAwardsTable.awardedAt));

  const rows = [["Position", "Player Name", "Category", "Amount", "Currency", "Notes", "Awarded At"]];
  for (const a of awards) {
    const amount = a.awardAmount ?? a.categoryValue ?? "";
    const currency = a.awardCurrency ?? a.categoryCurrency ?? "";
    // Extract position from notes if present ("Position X · …" format)
    const posMatch = a.notes?.match(/^Position\s+(\d+)/);
    const position = posMatch ? posMatch[1] : "";
    rows.push([position, a.playerName, a.categoryName, String(amount), currency, a.notes ?? "", new Date(a.awardedAt).toISOString()]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="payouts-${tournament?.name ?? tournamentId}.csv"`);
  res.send(csv);
});

export default router;
