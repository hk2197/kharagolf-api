/**
 * Corporate & Charity Golf Event routes (Task #92)
 *
 * Corporate:
 *   GET/PUT /organizations/:orgId/tournaments/:tournamentId/corporate-profile
 *   GET/POST /organizations/:orgId/tournaments/:tournamentId/corporate-teams
 *   PUT/DELETE /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId
 *   POST /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId/members
 *   DELETE /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId/members/:playerId
 *   GET /organizations/:orgId/tournaments/:tournamentId/corporate-leaderboard
 *   GET /organizations/:orgId/tournaments/:tournamentId/corporate-invoice (PDF)
 *
 * Charity:
 *   GET/PUT /organizations/:orgId/tournaments/:tournamentId/charity-profile
 *   GET/POST /organizations/:orgId/tournaments/:tournamentId/charity-challenges
 *   PUT/DELETE /organizations/:orgId/tournaments/:tournamentId/charity-challenges/:challengeId
 *   POST /organizations/:orgId/tournaments/:tournamentId/charity-challenges/:challengeId/result
 *   GET /organizations/:orgId/tournaments/:tournamentId/charity-report (PDF)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  tournamentsTable, playersTable, scoresTable, holeDetailsTable, coursesTable, organizationsTable,
  corporateEventProfilesTable, corporateTeamsTable, corporateTeamMembersTable,
  charityChallengesTable, charityFundraisingTotalsTable, charityChallengeResultsTable,
} from "@workspace/db";
import { eq, and, inArray, asc, sql } from "drizzle-orm";
import { requireOrgAdmin, requireTournamentAccess } from "../lib/permissions";
import { computePlayingHandicap } from "../lib/handicap";
import PDFDocument from "pdfkit";

const router: IRouter = Router({ mergeParams: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex ?? "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [30, 77, 43];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.startsWith("127.") || host === "0.0.0.0") return false;
    if (host === "169.254.169.254") return false;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch { return false; }
}

async function fetchLogoBuffer(url: string | null): Promise<Buffer | null> {
  if (!url || !isSafeUrl(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// ─── Corporate Profile ────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/corporate-profile
router.get("/:tournamentId/corporate-profile", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const [profile] = await db.select().from(corporateEventProfilesTable).where(eq(corporateEventProfilesTable.tournamentId, tournamentId));
  res.json(profile ?? null);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/corporate-profile
router.put("/:tournamentId/corporate-profile", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    companyName, contactName, contactEmail, contactPhone,
    logoUrl, primaryColor, secondaryColor,
    invoiceAddress, vatNumber, purchaseOrderRef, invoiceNotes,
  } = req.body;

  if (!companyName) { { res.status(400).json({ error: "companyName is required" }); return; } }

  // Mark tournament as corporate
  await db.update(tournamentsTable).set({ eventType: "corporate", updatedAt: new Date() })
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  const existing = await db.select({ id: corporateEventProfilesTable.id }).from(corporateEventProfilesTable)
    .where(eq(corporateEventProfilesTable.tournamentId, tournamentId));

  const profileData = {
    tournamentId, companyName, contactName: contactName ?? null, contactEmail: contactEmail ?? null,
    contactPhone: contactPhone ?? null, logoUrl: logoUrl ?? null, primaryColor: primaryColor ?? "#1e4d2b",
    secondaryColor: secondaryColor ?? "#ffffff", invoiceAddress: invoiceAddress ?? null,
    vatNumber: vatNumber ?? null, purchaseOrderRef: purchaseOrderRef ?? null, invoiceNotes: invoiceNotes ?? null,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    const [updated] = await db.update(corporateEventProfilesTable).set(profileData)
      .where(eq(corporateEventProfilesTable.tournamentId, tournamentId)).returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(corporateEventProfilesTable).values(profileData).returning();
    res.json(created);
  }
});

// ─── Corporate Teams ──────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/corporate-teams
router.get("/:tournamentId/corporate-teams", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const teams = await db.select().from(corporateTeamsTable)
    .where(eq(corporateTeamsTable.tournamentId, tournamentId))
    .orderBy(asc(corporateTeamsTable.teamName));

  const teamIds = teams.map(t => t.id);
  const members = teamIds.length > 0
    ? await db.select({
        id: corporateTeamMembersTable.id, teamId: corporateTeamMembersTable.teamId,
        playerId: corporateTeamMembersTable.playerId,
        firstName: playersTable.firstName, lastName: playersTable.lastName,
        handicapIndex: playersTable.handicapIndex,
      }).from(corporateTeamMembersTable)
        .innerJoin(playersTable, eq(corporateTeamMembersTable.playerId, playersTable.id))
        .where(inArray(corporateTeamMembersTable.teamId, teamIds))
    : [];

  const result = teams.map(team => ({
    ...team,
    members: members.filter(m => m.teamId === team.id),
  }));
  res.json(result);
});

// POST /organizations/:orgId/tournaments/:tournamentId/corporate-teams
router.post("/:tournamentId/corporate-teams", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { companyName, teamName, contactName, contactEmail, logoUrl, colour } = req.body;
  if (!companyName || !teamName) { { res.status(400).json({ error: "companyName and teamName are required" }); return; } }
  const [team] = await db.insert(corporateTeamsTable).values({
    tournamentId, companyName, teamName, contactName: contactName ?? null,
    contactEmail: contactEmail ?? null, logoUrl: logoUrl ?? null, colour: colour ?? "#22c55e",
  }).returning();
  res.status(201).json(team);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId
router.put("/:tournamentId/corporate-teams/:teamId", async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { companyName, teamName, contactName, contactEmail, logoUrl, colour } = req.body;
  const [team] = await db.update(corporateTeamsTable).set({
    companyName: companyName ?? undefined, teamName: teamName ?? undefined,
    contactName: contactName ?? null, contactEmail: contactEmail ?? null,
    logoUrl: logoUrl ?? null, colour: colour ?? undefined,
  }).where(and(eq(corporateTeamsTable.id, teamId), eq(corporateTeamsTable.tournamentId, tournamentId))).returning();
  if (!team) { { res.status(404).json({ error: "Team not found" }); return; } }
  res.json(team);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId
router.delete("/:tournamentId/corporate-teams/:teamId", async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(corporateTeamsTable)
    .where(and(eq(corporateTeamsTable.id, teamId), eq(corporateTeamsTable.tournamentId, tournamentId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId/members
router.post("/:tournamentId/corporate-teams/:teamId/members", async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const { playerId } = req.body;
  if (!playerId) { { res.status(400).json({ error: "playerId required" }); return; } }
  const [member] = await db.insert(corporateTeamMembersTable).values({ teamId, playerId: parseInt(playerId) })
    .onConflictDoNothing().returning();
  res.status(201).json(member ?? { teamId, playerId: parseInt(playerId) });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/corporate-teams/:teamId/members/:playerId
router.delete("/:tournamentId/corporate-teams/:teamId/members/:playerId", async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  await db.delete(corporateTeamMembersTable)
    .where(and(eq(corporateTeamMembersTable.teamId, teamId), eq(corporateTeamMembersTable.playerId, playerId)));
  res.json({ ok: true });
});

// ─── Corporate Leaderboard ────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/corporate-leaderboard
router.get("/:tournamentId/corporate-leaderboard", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [tournament] = await db.select({
    id: tournamentsTable.id, courseId: tournamentsTable.courseId,
    rounds: tournamentsTable.rounds, handicapAllowance: tournamentsTable.handicapAllowance,
  }).from(tournamentsTable).where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const teams = await db.select().from(corporateTeamsTable)
    .where(eq(corporateTeamsTable.tournamentId, tournamentId));

  const allMembers = teams.length > 0
    ? await db.select({
        id: corporateTeamMembersTable.id, teamId: corporateTeamMembersTable.teamId, playerId: corporateTeamMembersTable.playerId,
        firstName: playersTable.firstName, lastName: playersTable.lastName, handicapIndex: playersTable.handicapIndex,
        handicapOverride: playersTable.handicapOverride,
      }).from(corporateTeamMembersTable)
        .innerJoin(playersTable, eq(corporateTeamMembersTable.playerId, playersTable.id))
        .where(inArray(corporateTeamMembersTable.teamId, teams.map(t => t.id)))
    : [];

  const playerIds = allMembers.map(m => m.playerId);
  const courseData = tournament.courseId
    ? await db.select({ slope: coursesTable.slope, rating: coursesTable.rating, par: coursesTable.par })
        .from(coursesTable).where(eq(coursesTable.id, tournament.courseId)).then(r => r[0] ?? null)
    : null;
  const holeDetails = tournament.courseId
    ? await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(asc(holeDetailsTable.holeNumber))
    : [];

  const scores = playerIds.length > 0
    ? await db.select({ playerId: scoresTable.playerId, round: scoresTable.round, strokes: scoresTable.strokes, holeNumber: scoresTable.holeNumber })
        .from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId))
    : [];

  const teamLeaderboard = teams.map(team => {
    const members = allMembers.filter(m => m.teamId === team.id);
    let totalGross = 0;
    let totalNet = 0;
    let holesPlayed = 0;

    const memberScores = members.map(member => {
      const playerScores = scores.filter(s => s.playerId === member.playerId);
      const gross = playerScores.reduce((acc, s) => acc + s.strokes, 0);
      const hi = member.handicapOverride != null ? Number(member.handicapOverride) : (member.handicapIndex ? Number(member.handicapIndex) : 0);
      const playingHcp = computePlayingHandicap(hi, courseData?.slope == null ? null : Number(courseData.slope), courseData?.rating == null ? null : Number(courseData.rating), courseData?.par ?? 72, tournament.handicapAllowance ?? 100);
      const net = gross > 0 ? gross - playingHcp : 0;
      const holes = playerScores.length;
      totalGross += gross;
      totalNet += net;
      holesPlayed = Math.max(holesPlayed, holes);
      return { playerId: member.playerId, firstName: member.firstName, lastName: member.lastName, gross, net, holes };
    });

    return {
      team: { id: team.id, teamName: team.teamName, companyName: team.companyName, colour: team.colour },
      members: memberScores, totalGross, totalNet, holesPlayed,
      avgGross: members.length > 0 ? Math.round(totalGross / members.length) : 0,
      avgNet: members.length > 0 ? Math.round(totalNet / members.length) : 0,
    };
  }).sort((a, b) => a.totalNet - b.totalNet);

  // Add position
  const ranked = teamLeaderboard.map((t, i) => ({ ...t, position: i + 1 }));
  res.json(ranked);
});

// ─── Corporate Invoice PDF ────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/corporate-invoice
router.get("/:tournamentId/corporate-invoice", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [tournament] = await db.select({
    id: tournamentsTable.id, name: tournamentsTable.name, startDate: tournamentsTable.startDate,
    rounds: tournamentsTable.rounds, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency,
  }).from(tournamentsTable).where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [profile] = await db.select().from(corporateEventProfilesTable)
    .where(eq(corporateEventProfilesTable.tournamentId, tournamentId));
  if (!profile) { { res.status(400).json({ error: "No corporate profile configured for this tournament" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const players = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, paymentStatus: playersTable.paymentStatus })
    .from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  const teams = await db.select().from(corporateTeamsTable).where(eq(corporateTeamsTable.tournamentId, tournamentId));

  // Build PDF
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="invoice-${tournamentId}.pdf"`);
  doc.pipe(res);

  const [pr, pg, pb] = hexToRgb(profile.primaryColor ?? "#1e4d2b");

  // Header bar
  doc.rect(0, 0, doc.page.width, 80).fill([pr, pg, pb]);
  doc.fillColor("white").fontSize(22).font("Helvetica-Bold").text(org?.name ?? "Golf Club", 50, 25, { lineBreak: false });
  doc.fontSize(10).font("Helvetica").text("CORPORATE EVENT INVOICE", 50, 52);

  // Company block
  doc.fillColor("#111").fontSize(14).font("Helvetica-Bold").text(profile.companyName, 50, 100);
  if (profile.contactName) doc.fontSize(10).font("Helvetica").text(profile.contactName, 50, 116);
  if (profile.contactEmail) doc.fontSize(10).text(profile.contactEmail, 50, 128);
  if (profile.invoiceAddress) {
    doc.fontSize(9).text(profile.invoiceAddress, 50, 142, { width: 250 });
  }

  // Invoice meta
  const invoiceDate = new Date().toLocaleDateString("en-GB");
  const eventDate = tournament.startDate ? new Date(tournament.startDate).toLocaleDateString("en-GB") : "TBD";
  doc.fontSize(10).font("Helvetica").text(`Invoice Date: ${invoiceDate}`, 350, 100);
  doc.text(`Event Date: ${eventDate}`, 350, 114);
  doc.text(`Event: ${tournament.name}`, 350, 128);
  if (profile.vatNumber) doc.text(`VAT No: ${profile.vatNumber}`, 350, 142);
  if (profile.purchaseOrderRef) doc.text(`PO Ref: ${profile.purchaseOrderRef}`, 350, 156);

  // Divider
  doc.moveTo(50, 175).lineTo(doc.page.width - 50, 175).stroke("#ccc");

  // Line items table header
  let y = 190;
  doc.rect(50, y, doc.page.width - 100, 22).fill([pr, pg, pb]);
  doc.fillColor("white").fontSize(10).font("Helvetica-Bold");
  doc.text("Description", 58, y + 6);
  doc.text("Qty", 340, y + 6);
  doc.text("Unit Price", 390, y + 6);
  doc.text("Total", 470, y + 6);
  y += 30;

  const currency = tournament.currency ?? "GBP";
  const entryFee = tournament.entryFee ? Number(tournament.entryFee) : 0;
  const playerCount = players.length;
  const lineTotal = entryFee * playerCount;

  doc.fillColor("#111").font("Helvetica").fontSize(10);
  doc.text(`${tournament.name} — Participation Fee`, 58, y);
  doc.text(String(playerCount), 340, y);
  doc.text(`${currency} ${entryFee.toFixed(2)}`, 390, y);
  doc.text(`${currency} ${lineTotal.toFixed(2)}`, 470, y);
  y += 18;

  // Teams listing
  if (teams.length > 0) {
    y += 8;
    doc.font("Helvetica-BoldOblique").fontSize(9).text("Teams:", 58, y);
    y += 14;
    teams.forEach(team => {
      doc.font("Helvetica").fontSize(9).text(`• ${team.teamName} (${team.companyName})`, 68, y);
      y += 12;
    });
    y += 4;
  }

  // Divider
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke("#ccc");
  y += 10;

  // Totals
  doc.font("Helvetica-Bold").fontSize(11).text(`TOTAL: ${currency} ${lineTotal.toFixed(2)}`, 390, y);

  if (profile.invoiceNotes) {
    y += 30;
    doc.font("Helvetica").fontSize(9).fillColor("#666").text("Notes:", 50, y);
    doc.text(profile.invoiceNotes, 50, y + 12, { width: doc.page.width - 100 });
  }

  // Footer
  doc.fontSize(8).fillColor("#999").text("Thank you for your business.", 50, doc.page.height - 60, { align: "center" });

  doc.end();
});

// ─── Charity Profile ──────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/charity-profile
router.get("/:tournamentId/charity-profile", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const [profile] = await db.select().from(charityFundraisingTotalsTable)
    .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId));
  res.json(profile ?? null);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/charity-profile
router.put("/:tournamentId/charity-profile", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { charityName, charityLogoUrl, targetAmount, raisedAmount, currency, justgivingUrl, gofundmeUrl, donationPageUrl } = req.body;
  if (!charityName) { { res.status(400).json({ error: "charityName is required" }); return; } }

  // Mark tournament as charity
  await db.update(tournamentsTable).set({ eventType: "charity", updatedAt: new Date() })
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  const existing = await db.select({ id: charityFundraisingTotalsTable.id }).from(charityFundraisingTotalsTable)
    .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId));

  const profileData = {
    tournamentId, charityName, charityLogoUrl: charityLogoUrl ?? null,
    targetAmount: targetAmount ? String(targetAmount) : null,
    raisedAmount: raisedAmount ? String(raisedAmount) : "0",
    currency: currency ?? "GBP",
    justgivingUrl: justgivingUrl ?? null, gofundmeUrl: gofundmeUrl ?? null,
    donationPageUrl: donationPageUrl ?? null, updatedAt: new Date(),
  };

  if (existing.length > 0) {
    const [updated] = await db.update(charityFundraisingTotalsTable).set(profileData)
      .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId)).returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(charityFundraisingTotalsTable).values(profileData).returning();
    res.json(created);
  }
});

// ─── Charity Challenges ───────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/charity-challenges
router.get("/:tournamentId/charity-challenges", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const challenges = await db.select().from(charityChallengesTable)
    .where(eq(charityChallengesTable.tournamentId, tournamentId))
    .orderBy(asc(charityChallengesTable.displayOrder), asc(charityChallengesTable.id));
  const challengeIds = challenges.map(c => c.id);
  const results = challengeIds.length > 0
    ? await db.select().from(charityChallengeResultsTable)
        .where(inArray(charityChallengeResultsTable.challengeId, challengeIds))
    : [];
  const data = challenges.map(c => ({
    ...c, result: results.find(r => r.challengeId === c.id) ?? null,
  }));
  res.json(data);
});

// POST /organizations/:orgId/tournaments/:tournamentId/charity-challenges
router.post("/:tournamentId/charity-challenges", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, description, challengeType, holeNumber, unit, donationPerUnit, currency, fixedDonation, targetAmount, displayOrder } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [challenge] = await db.insert(charityChallengesTable).values({
    tournamentId, name, description: description ?? null, challengeType: challengeType ?? "longest_drive",
    holeNumber: holeNumber ? parseInt(holeNumber) : null, unit: unit ?? "metres",
    donationPerUnit: donationPerUnit ? String(donationPerUnit) : null,
    currency: currency ?? "GBP",
    fixedDonation: fixedDonation ? String(fixedDonation) : null,
    targetAmount: targetAmount ? String(targetAmount) : null,
    displayOrder: displayOrder ? parseInt(displayOrder) : 0,
  }).returning();
  res.status(201).json(challenge);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/charity-challenges/:challengeId
router.put("/:tournamentId/charity-challenges/:challengeId", async (req: Request, res: Response) => {
  const challengeId = parseInt(String((req.params as Record<string, string>).challengeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, description, challengeType, holeNumber, unit, donationPerUnit, currency, fixedDonation, targetAmount, displayOrder } = req.body;
  const [challenge] = await db.update(charityChallengesTable).set({
    name: name ?? undefined, description: description ?? null, challengeType: challengeType ?? undefined,
    holeNumber: holeNumber != null ? parseInt(holeNumber) : null, unit: unit ?? undefined,
    donationPerUnit: donationPerUnit != null ? String(donationPerUnit) : null,
    currency: currency ?? undefined,
    fixedDonation: fixedDonation != null ? String(fixedDonation) : null,
    targetAmount: targetAmount != null ? String(targetAmount) : null,
    displayOrder: displayOrder != null ? parseInt(displayOrder) : undefined,
    updatedAt: new Date(),
  }).where(and(eq(charityChallengesTable.id, challengeId), eq(charityChallengesTable.tournamentId, tournamentId))).returning();
  if (!challenge) { { res.status(404).json({ error: "Challenge not found" }); return; } }
  res.json(challenge);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/charity-challenges/:challengeId
router.delete("/:tournamentId/charity-challenges/:challengeId", async (req: Request, res: Response) => {
  const challengeId = parseInt(String((req.params as Record<string, string>).challengeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(charityChallengesTable)
    .where(and(eq(charityChallengesTable.id, challengeId), eq(charityChallengesTable.tournamentId, tournamentId)));
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/charity-challenges/:challengeId/result
router.post("/:tournamentId/charity-challenges/:challengeId/result", async (req: Request, res: Response) => {
  const challengeId = parseInt(String((req.params as Record<string, string>).challengeId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { winnerPlayerId, winnerName, achievedValue, donationAmount, notes } = req.body;

  // Upsert result
  const existing = await db.select({ id: charityChallengeResultsTable.id })
    .from(charityChallengeResultsTable).where(eq(charityChallengeResultsTable.challengeId, challengeId));

  const resultData = {
    challengeId, tournamentId,
    winnerPlayerId: winnerPlayerId ? parseInt(winnerPlayerId) : null,
    winnerName: winnerName ?? null,
    achievedValue: achievedValue != null ? String(achievedValue) : null,
    donationAmount: donationAmount != null ? String(donationAmount) : null,
    notes: notes ?? null, recordedAt: new Date(),
  };

  let result;
  if (existing.length > 0) {
    [result] = await db.update(charityChallengeResultsTable).set(resultData)
      .where(eq(charityChallengeResultsTable.challengeId, challengeId)).returning();
  } else {
    [result] = await db.insert(charityChallengeResultsTable).values(resultData).returning();
  }

  // Auto-accumulate donation into raised amount if donationAmount provided
  if (donationAmount) {
    const [fundraisingTotal] = await db.select().from(charityFundraisingTotalsTable)
      .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId));
    if (fundraisingTotal) {
      const newRaised = Number(fundraisingTotal.raisedAmount ?? 0) + Number(donationAmount);
      await db.update(charityFundraisingTotalsTable)
        .set({ raisedAmount: String(newRaised), updatedAt: new Date() })
        .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId));
    }
  }

  res.status(201).json(result);
});

// ─── Charity Donation Summary Report PDF ─────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/charity-report
router.get("/:tournamentId/charity-report", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [tournament] = await db.select({
    id: tournamentsTable.id, name: tournamentsTable.name, startDate: tournamentsTable.startDate,
    format: tournamentsTable.format,
  }).from(tournamentsTable).where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [fundraising] = await db.select().from(charityFundraisingTotalsTable)
    .where(eq(charityFundraisingTotalsTable.tournamentId, tournamentId));
  if (!fundraising) { { res.status(400).json({ error: "No charity profile configured for this tournament" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const challenges = await db.select().from(charityChallengesTable)
    .where(eq(charityChallengesTable.tournamentId, tournamentId))
    .orderBy(asc(charityChallengesTable.displayOrder));

  const challengeIds = challenges.map(c => c.id);
  const results = challengeIds.length > 0
    ? await db.select().from(charityChallengeResultsTable)
        .where(inArray(charityChallengeResultsTable.challengeId, challengeIds))
    : [];

  const players = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  // Build PDF
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="charity-report-${tournamentId}.pdf"`);
  doc.pipe(res);

  const accentColor: [number, number, number] = [220, 38, 38]; // charity red

  // Header
  doc.rect(0, 0, doc.page.width, 85).fill(accentColor);
  doc.fillColor("white").fontSize(22).font("Helvetica-Bold").text(fundraising.charityName, 50, 20, { lineBreak: false });
  doc.fontSize(11).font("Helvetica").text(`${tournament.name} — Charity Fundraising Report`, 50, 48);
  doc.fontSize(9).text(org?.name ?? "Golf Club", 50, 64);

  // Fundraising summary box
  let y = 105;
  doc.rect(50, y, doc.page.width - 100, 60).fill([245, 245, 245]);
  doc.fillColor("#111").fontSize(13).font("Helvetica-Bold").text("Fundraising Summary", 65, y + 8);
  const raised = Number(fundraising.raisedAmount ?? 0);
  const target = fundraising.targetAmount ? Number(fundraising.targetAmount) : null;
  doc.fontSize(11).font("Helvetica")
    .text(`Total Raised: ${fundraising.currency} ${raised.toFixed(2)}`, 65, y + 28);
  if (target) {
    const pct = Math.min(100, Math.round((raised / target) * 100));
    doc.text(`Target: ${fundraising.currency} ${target.toFixed(2)} (${pct}% achieved)`, 300, y + 28);
  }
  if (fundraising.justgivingUrl) doc.fontSize(9).fillColor("#666").text(`JustGiving: ${fundraising.justgivingUrl}`, 65, y + 45);
  y += 80;

  // Challenges table
  if (challenges.length > 0) {
    doc.fillColor("#111").fontSize(12).font("Helvetica-Bold").text("On-Course Challenges", 50, y);
    y += 16;

    doc.rect(50, y, doc.page.width - 100, 22).fill(accentColor);
    doc.fillColor("white").fontSize(9).font("Helvetica-Bold");
    doc.text("Challenge", 58, y + 7);
    doc.text("Winner", 220, y + 7);
    doc.text("Result", 340, y + 7);
    doc.text("Donation", 450, y + 7);
    y += 28;

    challenges.forEach((challenge, i) => {
      const result = results.find(r => r.challengeId === challenge.id);
      const rowColor = i % 2 === 0 ? "#f9f9f9" : "#ffffff";
      doc.rect(50, y, doc.page.width - 100, 20).fill(rowColor);
      doc.fillColor("#111").font("Helvetica").fontSize(9);
      doc.text(challenge.name, 58, y + 6, { width: 155 });
      doc.text(result?.winnerName ?? "–", 220, y + 6, { width: 115 });
      const achieved = result?.achievedValue != null ? `${result.achievedValue} ${challenge.unit ?? ""}` : "–";
      doc.text(achieved, 340, y + 6, { width: 100 });
      const donation = result?.donationAmount != null ? `${fundraising.currency} ${Number(result.donationAmount).toFixed(2)}` : "–";
      doc.text(donation, 450, y + 6, { width: 100 });
      y += 22;
      if (y > doc.page.height - 100) { doc.addPage(); y = 50; }
    });
    y += 10;
  }

  // Progress bar
  if (target && raised >= 0) {
    y += 10;
    doc.fillColor("#111").fontSize(10).font("Helvetica-Bold").text("Progress to Target", 50, y);
    y += 14;
    const barW = doc.page.width - 100;
    doc.rect(50, y, barW, 16).fill("#e5e7eb");
    const pct = Math.min(1, raised / target);
    doc.rect(50, y, barW * pct, 16).fill(accentColor);
    doc.fillColor("white").fontSize(8).text(`${Math.round(pct * 100)}%`, 55, y + 4);
    y += 26;
  }

  // Footer
  doc.fontSize(8).fillColor("#999")
    .text(`Report generated on ${new Date().toLocaleDateString("en-GB")} by ${org?.name ?? "Golf Club"}`, 50, doc.page.height - 55, { align: "center" });

  doc.end();
});

export default router;
