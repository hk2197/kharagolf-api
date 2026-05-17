import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  displayBoardSettingsTable,
  displayCodesTable,
  tournamentsTable,
  organizationsTable,
  sponsorsTable,
  sideGamesConfigTable,
  sideGameResultsTable,
  playersTable,
  scoresTable,
} from "@workspace/db";
import { eq, and, gt, inArray, sql } from "drizzle-orm";
import { computeLeaderboard } from "../lib/realtime";

const router: IRouter = Router({ mergeParams: true });

function verifyAdmin(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (!["super_admin", "org_admin", "tournament_director"].includes(role ?? "")) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── DISPLAY CODE PAIRING ────────────────────────────────────────────────────

// POST /api/public/display/pair  — validate a display code (no auth required)
router.post("/public/display/pair", async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const upperCode = code.toUpperCase().trim();
  const now = new Date();

  const [row] = await db
    .select()
    .from(displayCodesTable)
    .where(
      and(
        eq(displayCodesTable.code, upperCode),
        sql`(${displayCodesTable.expiresAt} IS NULL OR ${displayCodesTable.expiresAt} > ${now})`,
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Invalid or expired display code" });
    return;
  }

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, row.organizationId));

  let tournamentName: string | null = null;
  if (row.tournamentId) {
    const [t] = await db
      .select({ name: tournamentsTable.name })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, row.tournamentId));
    tournamentName = t?.name ?? null;
  }

  res.json({
    organizationId: row.organizationId,
    tournamentId: row.tournamentId ?? null,
    label: row.label,
    organizationName: org?.name ?? null,
    organizationLogoUrl: org?.logoUrl ?? null,
    organizationPrimaryColor: org?.primaryColor ?? null,
    tournamentName,
  });
});

// GET /api/public/display/data/:orgId  — aggregate display data for the board (no auth)
// Can be filtered with ?tournamentId=X to get data for a specific tournament
router.get("/public/display/data/:orgId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const tournamentIdParam = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;

  // Get display settings
  const [settings] = await db
    .select()
    .from(displayBoardSettingsTable)
    .where(eq(displayBoardSettingsTable.organizationId, orgId));

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Determine which tournaments to show
  let tournamentIds: number[] = [];
  if (tournamentIdParam) {
    tournamentIds = [tournamentIdParam];
  } else if (settings?.activeTournamentIds && settings.activeTournamentIds.length > 0) {
    tournamentIds = settings.activeTournamentIds;
  } else {
    // Fall back to active tournaments in the org
    const active = await db
      .select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.organizationId, orgId), eq(tournamentsTable.status, "active")));
    tournamentIds = active.map(t => t.id);
  }

  if (tournamentIds.length === 0) {
    res.json({
      org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      settings: settings ?? null,
      tournaments: [],
    });
    return;
  }

  // Load all tournament data in parallel
  const tournaments = await Promise.all(tournamentIds.map(async (tid) => {
    const [tournament] = await db
      .select()
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)));

    if (!tournament) return null;

    // Compute leaderboard
    let leaderboard: Awaited<ReturnType<typeof computeLeaderboard>> | null = null;
    try { leaderboard = await computeLeaderboard(tid); } catch { leaderboard = null; }

    // Side games
    const [sgConfig] = await db.select().from(sideGamesConfigTable).where(eq(sideGamesConfigTable.tournamentId, tid));

    let sideGames: {
      config: typeof sgConfig | null;
      manual: Array<{
        id: number; gameType: string; holeNumber: number | null; round: number | null;
        notes: string | null; prize: string | null; playerName: string;
      }>;
      skins: Array<{
        hole: number; round: number; winnerName: string | null; winnerScore: number | null; tied: boolean;
      }>;
    } | null = null;

    if (sgConfig) {
      const manualResults = await db
        .select({
          id: sideGameResultsTable.id,
          gameType: sideGameResultsTable.gameType,
          holeNumber: sideGameResultsTable.holeNumber,
          round: sideGameResultsTable.round,
          notes: sideGameResultsTable.notes,
          prize: sideGameResultsTable.prize,
          firstName: playersTable.firstName,
          lastName: playersTable.lastName,
        })
        .from(sideGameResultsTable)
        .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
        .where(eq(sideGameResultsTable.tournamentId, tid));

      let skinsResults: Array<{ hole: number; round: number; winnerName: string | null; winnerScore: number | null; tied: boolean }> = [];

      if (sgConfig.skinsEnabled) {
        const allScores = await db
          .select({ playerId: scoresTable.playerId, holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes, round: scoresTable.round, firstName: playersTable.firstName, lastName: playersTable.lastName })
          .from(scoresTable)
          .leftJoin(playersTable, eq(playersTable.id, scoresTable.playerId))
          .where(eq(scoresTable.tournamentId, tid));

        for (let r = 1; r <= (tournament.rounds ?? 1); r++) {
          const roundScores = allScores.filter(s => s.round === r);
          for (let hole = 1; hole <= 18; hole++) {
            const hs = roundScores.filter(s => s.holeNumber === hole);
            if (hs.length === 0) continue;
            const minStrokes = Math.min(...hs.map(s => s.strokes));
            const winners = hs.filter(s => s.strokes === minStrokes);
            if (winners.length > 1) {
              skinsResults.push({ hole, round: r, winnerName: null, winnerScore: minStrokes, tied: true });
            } else {
              skinsResults.push({ hole, round: r, winnerName: `${winners[0].firstName} ${winners[0].lastName}`, winnerScore: winners[0].strokes, tied: false });
            }
          }
        }
      }

      sideGames = {
        config: sgConfig,
        manual: manualResults.map(m => ({
          id: m.id, gameType: m.gameType, holeNumber: m.holeNumber, round: m.round,
          notes: m.notes, prize: m.prize,
          playerName: `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim(),
        })),
        skins: skinsResults,
      };
    }

    // Sponsors for this tournament
    const sponsors = await db
      .select({ id: sponsorsTable.id, name: sponsorsTable.name, logoUrl: sponsorsTable.logoUrl, tier: sponsorsTable.tier, websiteUrl: sponsorsTable.websiteUrl })
      .from(sponsorsTable)
      .where(
        sql`${sponsorsTable.organizationId} = ${orgId} AND ${sponsorsTable.isActive} = true AND (${sponsorsTable.tournamentId} IS NULL OR ${sponsorsTable.tournamentId} = ${tid})`,
      )
      .orderBy(sponsorsTable.displayOrder);

    return {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      status: tournament.status,
      rounds: tournament.rounds,
      coursePar: leaderboard?.coursePar ?? 72,
      leaderboard: leaderboard
        ? {
            entries: leaderboard.entries,
            netEntries: leaderboard.netEntries,
            byFlight: leaderboard.byFlight,
            flights: leaderboard.flights,
            isTeamFormat: leaderboard.isTeamFormat,
            teamEntries: leaderboard.teamEntries,
            lastUpdated: leaderboard.lastUpdated,
          }
        : null,
      sideGames,
      sponsors,
    };
  }));

  res.json({
    org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
    settings: settings ?? {
      rotationSequence: ["leaderboard", "tracker", "sidegames", "sponsor"],
      rotationIntervalSeconds: 20,
      sponsorSlideDurationSeconds: 10,
      showSponsorSlides: true,
      showSideGames: true,
      showTracker: true,
    },
    tournaments: tournaments.filter(Boolean),
  });
});

// ─── ADMIN — Display Board Settings ──────────────────────────────────────────

// GET /api/organizations/:orgId/display-settings
router.get("/organizations/:orgId/display-settings", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const [settings] = await db
    .select()
    .from(displayBoardSettingsTable)
    .where(eq(displayBoardSettingsTable.organizationId, orgId));

  if (!settings) {
    res.json({
      organizationId: orgId,
      activeTournamentIds: [],
      rotationSequence: ["leaderboard", "tracker", "sidegames", "sponsor"],
      rotationIntervalSeconds: 20,
      sponsorSlideDurationSeconds: 10,
      showSponsorSlides: true,
      showSideGames: true,
      showTracker: true,
    });
    return;
  }

  res.json(settings);
});

// PUT /api/organizations/:orgId/display-settings
router.put("/organizations/:orgId/display-settings", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const {
    activeTournamentIds, rotationSequence, rotationIntervalSeconds,
    sponsorSlideDurationSeconds, showSponsorSlides, showSideGames, showTracker,
  } = req.body;

  const [upserted] = await db
    .insert(displayBoardSettingsTable)
    .values({
      organizationId: orgId,
      activeTournamentIds: activeTournamentIds ?? [],
      rotationSequence: rotationSequence ?? ["leaderboard", "tracker", "sidegames", "sponsor"],
      rotationIntervalSeconds: rotationIntervalSeconds ?? 20,
      sponsorSlideDurationSeconds: sponsorSlideDurationSeconds ?? 10,
      showSponsorSlides: showSponsorSlides ?? true,
      showSideGames: showSideGames ?? true,
      showTracker: showTracker ?? true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [displayBoardSettingsTable.organizationId],
      set: {
        activeTournamentIds: activeTournamentIds ?? [],
        rotationSequence: rotationSequence ?? ["leaderboard", "tracker", "sidegames", "sponsor"],
        rotationIntervalSeconds: rotationIntervalSeconds ?? 20,
        sponsorSlideDurationSeconds: sponsorSlideDurationSeconds ?? 10,
        showSponsorSlides: showSponsorSlides ?? true,
        showSideGames: showSideGames ?? true,
        showTracker: showTracker ?? true,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(upserted);
});

// GET /api/organizations/:orgId/display-codes
router.get("/organizations/:orgId/display-codes", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const codes = await db
    .select()
    .from(displayCodesTable)
    .where(eq(displayCodesTable.organizationId, orgId))
    .orderBy(displayCodesTable.createdAt);

  res.json(codes);
});

// POST /api/organizations/:orgId/display-codes  — generate a new display code
router.post("/organizations/:orgId/display-codes", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { tournamentId, label, expiresInHours } = req.body;

  // Validate tournament belongs to org if provided
  if (tournamentId) {
    const [t] = await db
      .select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, parseInt(tournamentId)), eq(tournamentsTable.organizationId, orgId)));
    if (!t) { { res.status(404).json({ error: "Tournament not found in this organization" }); return; } }
  }

  let expiresAt: Date | null = null;
  if (expiresInHours) {
    expiresAt = new Date(Date.now() + parseInt(expiresInHours) * 60 * 60 * 1000);
  }

  // Generate unique code
  let code = generateCode();
  let attempts = 0;
  while (attempts < 10) {
    const [existing] = await db.select({ id: displayCodesTable.id }).from(displayCodesTable).where(eq(displayCodesTable.code, code));
    if (!existing) break;
    code = generateCode();
    attempts++;
  }

  const [created] = await db
    .insert(displayCodesTable)
    .values({
      code,
      organizationId: orgId,
      tournamentId: tournamentId ? parseInt(tournamentId) : null,
      label: label ?? null,
      expiresAt,
      createdBy: req.user?.id ?? null,
    })
    .returning();

  res.status(201).json(created);
});

// DELETE /api/organizations/:orgId/display-codes/:codeId
router.delete("/organizations/:orgId/display-codes/:codeId", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const codeId = parseInt(String((req.params as Record<string, string>).codeId));

  const deleted = await db
    .delete(displayCodesTable)
    .where(and(eq(displayCodesTable.id, codeId), eq(displayCodesTable.organizationId, orgId)))
    .returning({ id: displayCodesTable.id });

  if (deleted.length === 0) { { res.status(404).json({ error: "Display code not found" }); return; } }
  res.json({ deleted: true });
});

export default router;
