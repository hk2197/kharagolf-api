import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { tournamentTemplatesTable, tournamentsTable, flightsTable, sideGamesConfigTable, sponsorsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

type TemplateInsert = typeof tournamentTemplatesTable.$inferInsert;
type TemplateUpdate = Partial<Omit<TemplateInsert, "id" | "organizationId" | "createdAt" | "updatedAt">>;

// TemplateConfig is stored as JSONB in the `config` column.
// It persists extended tournament setup that flat scalar columns cannot capture.
interface TemplateConfig {
  flights?: Array<{ name: string; maxPlayers: number | null; handicapMin: number | null; handicapMax: number | null; flightOrder: number | null }>;
  sideGames?: Array<{ gameType: string; name: string | null; config: unknown }>;
  sponsorNames?: string[];
  courseConditions?: string | null;
  groupSize?: number | null;
  startingHoles?: number[] | null;
}

async function fetchTemplateConfig(tournamentId: number, orgId: number): Promise<TemplateConfig> {
  const [flights, sideGamesConfig, sponsors] = await Promise.all([
    db.select({
      id: flightsTable.id,
      name: flightsTable.name,
      maxPlayers: flightsTable.maxPlayers,
      handicapMin: flightsTable.handicapMin,
      handicapMax: flightsTable.handicapMax,
    }).from(flightsTable).where(eq(flightsTable.tournamentId, tournamentId)).orderBy(asc(flightsTable.id)),
    db.select().from(sideGamesConfigTable).where(eq(sideGamesConfigTable.tournamentId, tournamentId)),
    db.select({ name: sponsorsTable.name })
      .from(sponsorsTable)
      .where(and(
        eq(sponsorsTable.organizationId, orgId),
        eq(sponsorsTable.isActive, true),
        eq(sponsorsTable.tournamentId, tournamentId),
      )),
  ]);
  // Derive enabled side games from the per-tournament boolean flags
  const sideGames: TemplateConfig["sideGames"] = [];
  for (const cfg of sideGamesConfig) {
    if (cfg.skinsEnabled) sideGames.push({ gameType: "skins", name: null, config: { prize: cfg.skinsPrize ?? null } });
    if (cfg.ctpEnabled) sideGames.push({ gameType: "nearest_pin", name: null, config: { holes: cfg.ctpHoles, prize: cfg.ctpPrize ?? null, sponsorId: cfg.ctpSponsorId } });
    if (cfg.ldEnabled) sideGames.push({ gameType: "longest_drive", name: null, config: { holes: cfg.ldHoles, prize: cfg.ldPrize ?? null, sponsorId: cfg.ldSponsorId } });
    if (cfg.greeniesEnabled) sideGames.push({ gameType: "greenies", name: null, config: { prize: cfg.greeniesPrize ?? null } });
  }
  return {
    flights: flights.length > 0
      ? flights.map((f, i) => ({
          name: f.name,
          maxPlayers: f.maxPlayers,
          handicapMin: f.handicapMin != null ? Number(f.handicapMin) : null,
          handicapMax: f.handicapMax != null ? Number(f.handicapMax) : null,
          flightOrder: i,
        }))
      : undefined,
    sideGames: sideGames.length > 0 ? sideGames : undefined,
    sponsorNames: sponsors.length > 0 ? sponsors.map(s => s.name) : undefined,
  };
}

// GET /api/organizations/:orgId/tournament-templates
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const templates = await db
    .select()
    .from(tournamentTemplatesTable)
    .where(eq(tournamentTemplatesTable.organizationId, orgId))
    .orderBy(asc(tournamentTemplatesTable.name));
  res.json(templates);
});

// POST /api/organizations/:orgId/tournament-templates
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    name, description, format, rounds, handicapAllowance, maxPlayers, entryFee, currency,
    selfPosting, markerValidation, tiebreakerMethod, leaderboardType,
    autoWelcome, autoReminder, autoResults, localRules, config,
  } = req.body;
  if (!name || !format) { { res.status(400).json({ error: "name and format are required" }); return; } }
  const [template] = await db.insert(tournamentTemplatesTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    format,
    rounds: rounds ?? 1,
    handicapAllowance: handicapAllowance ?? 100,
    maxPlayers: maxPlayers ?? null,
    entryFee: entryFee ? String(entryFee) : null,
    currency: currency ?? "INR",
    selfPosting: selfPosting ?? false,
    markerValidation: markerValidation ?? false,
    tiebreakerMethod: tiebreakerMethod ?? "countback",
    leaderboardType: leaderboardType ?? "both",
    autoWelcome: autoWelcome ?? true,
    autoReminder: autoReminder ?? true,
    autoResults: autoResults ?? false,
    localRules: localRules ?? null,
    config: config ?? null,
    createdByUserId: req.user?.id ?? null,
  }).returning();
  res.status(201).json(template);
});

// PUT /api/organizations/:orgId/tournament-templates/:templateId
router.put("/:templateId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    name, description, format, rounds, handicapAllowance, maxPlayers, entryFee, currency,
    selfPosting, markerValidation, tiebreakerMethod, leaderboardType,
    autoWelcome, autoReminder, autoResults, localRules, config,
  } = req.body;
  const updates: TemplateUpdate = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (format !== undefined) updates.format = format;
  if (rounds !== undefined) updates.rounds = rounds;
  if (handicapAllowance !== undefined) updates.handicapAllowance = handicapAllowance;
  if (maxPlayers !== undefined) updates.maxPlayers = maxPlayers;
  if (entryFee !== undefined) updates.entryFee = entryFee ? String(entryFee) : null;
  if (currency !== undefined) updates.currency = currency;
  if (selfPosting !== undefined) updates.selfPosting = selfPosting;
  if (markerValidation !== undefined) updates.markerValidation = markerValidation;
  if (tiebreakerMethod !== undefined) updates.tiebreakerMethod = tiebreakerMethod;
  if (leaderboardType !== undefined) updates.leaderboardType = leaderboardType;
  if (autoWelcome !== undefined) updates.autoWelcome = autoWelcome;
  if (autoReminder !== undefined) updates.autoReminder = autoReminder;
  if (autoResults !== undefined) updates.autoResults = autoResults;
  if (localRules !== undefined) updates.localRules = localRules;
  if (config !== undefined) (updates as Record<string, unknown>).config = config;

  if (Object.keys(updates).length === 0) { { res.status(400).json({ error: "No fields to update" }); return; } }
  const [updated] = await db
    .update(tournamentTemplatesTable)
    .set(updates)
    .where(and(
      eq(tournamentTemplatesTable.id, templateId),
      eq(tournamentTemplatesTable.organizationId, orgId),
    ))
    .returning();
  if (!updated) { { res.status(404).json({ error: "Template not found" }); return; } }
  res.json(updated);
});

// DELETE /api/organizations/:orgId/tournament-templates/:templateId
router.delete("/:templateId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(tournamentTemplatesTable)
    .where(and(
      eq(tournamentTemplatesTable.id, templateId),
      eq(tournamentTemplatesTable.organizationId, orgId),
    ));
  res.json({ success: true });
});

// POST /api/organizations/:orgId/tournament-templates/from-tournament/:tournamentId
// Save an existing tournament as a new template, capturing full config (flights, side games, sponsors)
router.post("/from-tournament/:tournamentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { templateName, courseConditions, groupSize } = req.body;
  const [tournament] = await db.select().from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.id, tournamentId),
      eq(tournamentsTable.organizationId, orgId),
    ));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const extendedConfig = await fetchTemplateConfig(tournamentId, orgId);
  if (courseConditions) extendedConfig.courseConditions = courseConditions;
  if (groupSize) extendedConfig.groupSize = groupSize;

  const [template] = await db.insert(tournamentTemplatesTable).values({
    organizationId: orgId,
    name: templateName ?? `${tournament.name} Template`,
    description: tournament.description ?? null,
    format: tournament.format,
    rounds: tournament.rounds,
    handicapAllowance: tournament.handicapAllowance,
    maxPlayers: tournament.maxPlayers ?? null,
    entryFee: tournament.entryFee ?? null,
    currency: tournament.currency,
    selfPosting: tournament.selfPosting,
    markerValidation: tournament.markerValidation,
    tiebreakerMethod: tournament.tiebreakerMethod,
    leaderboardType: tournament.leaderboardType,
    autoWelcome: tournament.autoWelcome,
    autoReminder: tournament.autoReminder,
    autoResults: tournament.autoResults,
    localRules: tournament.localRules ?? null,
    config: extendedConfig,
    createdByUserId: req.user?.id ?? null,
  }).returning();

  res.status(201).json(template);
});

// POST /api/organizations/:orgId/tournaments/from-template/:templateId
// Mounted separately in routes/index.ts at /organizations/:orgId/tournaments
export const createFromTemplateRouter: IRouter = Router({ mergeParams: true });

createFromTemplateRouter.post("/from-template/:templateId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [template] = await db.select().from(tournamentTemplatesTable)
    .where(and(
      eq(tournamentTemplatesTable.id, templateId),
      eq(tournamentTemplatesTable.organizationId, orgId),
    ));
  if (!template) { { res.status(404).json({ error: "Template not found" }); return; } }

  const extendedConfig = (template.config as TemplateConfig | null) ?? {};

  const { name, startDate, endDate, courseId } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name,
    format: template.format,
    rounds: template.rounds,
    handicapAllowance: template.handicapAllowance,
    maxPlayers: template.maxPlayers ?? null,
    entryFee: template.entryFee ?? null,
    currency: template.currency,
    selfPosting: template.selfPosting,
    markerValidation: template.markerValidation,
    tiebreakerMethod: template.tiebreakerMethod,
    leaderboardType: template.leaderboardType,
    autoWelcome: template.autoWelcome,
    autoReminder: template.autoReminder,
    autoResults: template.autoResults,
    localRules: template.localRules ?? null,
    description: template.description ?? null,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    courseId: courseId ?? null,
    status: "draft",
  }).returning();

  const appliedConfig: { flights?: number; sideGames?: number } = {};

  if (extendedConfig.flights && extendedConfig.flights.length > 0) {
    await db.insert(flightsTable).values(
      extendedConfig.flights.map(f => ({
        tournamentId: tournament.id,
        name: f.name,
        maxPlayers: f.maxPlayers ?? null,
        handicapMin: f.handicapMin != null ? String(f.handicapMin) : null,
        handicapMax: f.handicapMax != null ? String(f.handicapMax) : null,
      }))
    );
    appliedConfig.flights = extendedConfig.flights.length;
  }

  if (extendedConfig.sideGames && extendedConfig.sideGames.length > 0) {
    // Map game types to the per-tournament boolean flags on side_games_config
    const cfg: Partial<typeof sideGamesConfigTable.$inferInsert> = { tournamentId: tournament.id };
    for (const sg of extendedConfig.sideGames) {
      if (sg.gameType === "skins") cfg.skinsEnabled = true;
      else if (sg.gameType === "nearest_pin") cfg.ctpEnabled = true;
      else if (sg.gameType === "longest_drive") cfg.ldEnabled = true;
      else if (sg.gameType === "greenies") cfg.greeniesEnabled = true;
    }
    await db.insert(sideGamesConfigTable).values(cfg as typeof sideGamesConfigTable.$inferInsert);
    appliedConfig.sideGames = extendedConfig.sideGames.length;
  }

  res.status(201).json({ ...tournament, appliedFromTemplate: template.id, appliedConfig, templateConfig: extendedConfig });
});

export default router;
