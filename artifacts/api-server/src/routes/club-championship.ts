import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  clubChampionshipTable,
  championshipFlightTable,
  championshipWinnerTable,
  tournamentsTable,
  organizationsTable,
  flightsTable,
  playersTable,
  appUsersTable,
  deviceTokensTable,
  messageLogsTable,
} from "@workspace/db";
import { eq, and, asc, desc, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendBroadcast } from "../lib/comms";

const router: IRouter = Router({ mergeParams: true });

// ─── CLUB CHAMPIONSHIP CRUD ──────────────────────────────────────────────────

// GET /organizations/:orgId/club-championships
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const championships = await db
    .select({
      id: clubChampionshipTable.id,
      organizationId: clubChampionshipTable.organizationId,
      tournamentId: clubChampionshipTable.tournamentId,
      year: clubChampionshipTable.year,
      title: clubChampionshipTable.title,
      notes: clubChampionshipTable.notes,
      isPublished: clubChampionshipTable.isPublished,
      createdAt: clubChampionshipTable.createdAt,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
    })
    .from(clubChampionshipTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, clubChampionshipTable.tournamentId))
    .where(eq(clubChampionshipTable.organizationId, orgId))
    .orderBy(desc(clubChampionshipTable.year));

  res.json(championships);
});

// GET /organizations/:orgId/club-championships/:id
router.get("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const [championship] = await db
    .select({
      id: clubChampionshipTable.id,
      organizationId: clubChampionshipTable.organizationId,
      tournamentId: clubChampionshipTable.tournamentId,
      year: clubChampionshipTable.year,
      title: clubChampionshipTable.title,
      notes: clubChampionshipTable.notes,
      isPublished: clubChampionshipTable.isPublished,
      createdAt: clubChampionshipTable.createdAt,
      updatedAt: clubChampionshipTable.updatedAt,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
      tournamentFormat: tournamentsTable.format,
      tournamentStartDate: tournamentsTable.startDate,
    })
    .from(clubChampionshipTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, clubChampionshipTable.tournamentId))
    .where(and(eq(clubChampionshipTable.id, id), eq(clubChampionshipTable.organizationId, orgId)));

  if (!championship) {
    res.status(404).json({ error: "Club championship not found" });
    return;
  }

  const flights = await db
    .select({
      id: championshipFlightTable.id,
      name: championshipFlightTable.name,
      description: championshipFlightTable.description,
      scoreType: championshipFlightTable.scoreType,
      displayOrder: championshipFlightTable.displayOrder,
      flightId: championshipFlightTable.flightId,
      flightName: flightsTable.name,
    })
    .from(championshipFlightTable)
    .leftJoin(flightsTable, eq(flightsTable.id, championshipFlightTable.flightId))
    .where(eq(championshipFlightTable.championshipId, id))
    .orderBy(asc(championshipFlightTable.displayOrder));

  const winners = await db
    .select()
    .from(championshipWinnerTable)
    .where(eq(championshipWinnerTable.championshipId, id))
    .orderBy(asc(championshipWinnerTable.position));

  res.json({ ...championship, flights, winners });
});

// POST /organizations/:orgId/club-championships
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { tournamentId, year, title, notes } = req.body;
  if (!tournamentId || !year) {
    res.status(400).json({ error: "tournamentId and year are required" });
    return;
  }

  const [championship] = await db
    .insert(clubChampionshipTable)
    .values({
      organizationId: orgId,
      tournamentId: parseInt(tournamentId),
      year: parseInt(year),
      title: title ?? "Club Championship",
      notes: notes ?? null,
    })
    .returning();

  res.status(201).json(championship);
});

// PATCH /organizations/:orgId/club-championships/:id
router.patch("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { title, notes, isPublished } = req.body;

  const [updated] = await db
    .update(clubChampionshipTable)
    .set({
      ...(title !== undefined ? { title } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isPublished !== undefined ? { isPublished } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(clubChampionshipTable.id, id), eq(clubChampionshipTable.organizationId, orgId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Championship not found" });
    return;
  }

  res.json(updated);
});

// DELETE /organizations/:orgId/club-championships/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db
    .delete(clubChampionshipTable)
    .where(and(eq(clubChampionshipTable.id, id), eq(clubChampionshipTable.organizationId, orgId)));

  res.status(204).end();
});

// ─── CHAMPIONSHIP FLIGHTS ────────────────────────────────────────────────────

// GET /organizations/:orgId/club-championships/:id/flights
router.get("/:id/flights", async (req: Request, res: Response) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const flights = await db
    .select({
      id: championshipFlightTable.id,
      name: championshipFlightTable.name,
      description: championshipFlightTable.description,
      scoreType: championshipFlightTable.scoreType,
      displayOrder: championshipFlightTable.displayOrder,
      flightId: championshipFlightTable.flightId,
      flightName: flightsTable.name,
    })
    .from(championshipFlightTable)
    .leftJoin(flightsTable, eq(flightsTable.id, championshipFlightTable.flightId))
    .where(eq(championshipFlightTable.championshipId, id))
    .orderBy(asc(championshipFlightTable.displayOrder));

  res.json(flights);
});

// POST /organizations/:orgId/club-championships/:id/flights
router.post("/:id/flights", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const championshipId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, scoreType, displayOrder, flightId } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [flight] = await db
    .insert(championshipFlightTable)
    .values({
      championshipId,
      name,
      description: description ?? null,
      scoreType: scoreType ?? "net",
      displayOrder: displayOrder ?? 0,
      flightId: flightId ? parseInt(flightId) : null,
    })
    .returning();

  res.status(201).json(flight);
});

// PATCH /organizations/:orgId/club-championships/:id/flights/:flightId
router.patch("/:id/flights/:flightId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, scoreType, displayOrder } = req.body;

  const [updated] = await db
    .update(championshipFlightTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(scoreType !== undefined ? { scoreType } : {}),
      ...(displayOrder !== undefined ? { displayOrder } : {}),
    })
    .where(eq(championshipFlightTable.id, flightId))
    .returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/club-championships/:id/flights/:flightId
router.delete("/:id/flights/:flightId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(championshipFlightTable).where(eq(championshipFlightTable.id, flightId));
  res.status(204).end();
});

// ─── CHAMPIONSHIP WINNERS ─────────────────────────────────────────────────────

// GET /organizations/:orgId/club-championships/:id/winners
router.get("/:id/winners", async (req: Request, res: Response) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const winners = await db
    .select()
    .from(championshipWinnerTable)
    .where(eq(championshipWinnerTable.championshipId, id))
    .orderBy(asc(championshipWinnerTable.position));

  res.json(winners);
});

// POST /organizations/:orgId/club-championships/:id/winners
router.post("/:id/winners", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const championshipId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { flightId, playerId, playerName, score, notes, position } = req.body;
  if (!playerName) {
    res.status(400).json({ error: "playerName is required" });
    return;
  }

  const [winner] = await db
    .insert(championshipWinnerTable)
    .values({
      championshipId,
      flightId: flightId ? parseInt(flightId) : null,
      playerId: playerId ? parseInt(playerId) : null,
      playerName,
      score: score ?? null,
      notes: notes ?? null,
      position: position ?? 1,
    })
    .returning();

  res.status(201).json(winner);
});

// PATCH /organizations/:orgId/club-championships/:id/winners/:winnerId
router.patch("/:id/winners/:winnerId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const winnerId = parseInt(String((req.params as Record<string, string>).winnerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { playerName, score, notes, position, flightId } = req.body;

  const [updated] = await db
    .update(championshipWinnerTable)
    .set({
      ...(playerName !== undefined ? { playerName } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(flightId !== undefined ? { flightId: flightId ? parseInt(flightId) : null } : {}),
    })
    .where(eq(championshipWinnerTable.id, winnerId))
    .returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/club-championships/:id/winners/:winnerId
router.delete("/:id/winners/:winnerId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const winnerId = parseInt(String((req.params as Record<string, string>).winnerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(championshipWinnerTable).where(eq(championshipWinnerTable.id, winnerId));
  res.status(204).end();
});

// ─── NOTIFY CHAMPIONSHIP RESULTS ─────────────────────────────────────────────

// POST /organizations/:orgId/club-championships/:id/notify
router.post("/:id/notify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [championship] = await db
    .select({
      id: clubChampionshipTable.id,
      year: clubChampionshipTable.year,
      title: clubChampionshipTable.title,
      tournamentId: clubChampionshipTable.tournamentId,
      tournamentName: tournamentsTable.name,
      orgName: organizationsTable.name,
      orgLogo: organizationsTable.logoUrl,
      orgColor: organizationsTable.primaryColor,
    })
    .from(clubChampionshipTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, clubChampionshipTable.tournamentId))
    .leftJoin(organizationsTable, eq(organizationsTable.id, clubChampionshipTable.organizationId))
    .where(and(eq(clubChampionshipTable.id, id), eq(clubChampionshipTable.organizationId, orgId)));

  if (!championship) {
    res.status(404).json({ error: "Championship not found" });
    return;
  }

  const winners = await db
    .select()
    .from(championshipWinnerTable)
    .where(and(eq(championshipWinnerTable.championshipId, id), eq(championshipWinnerTable.position, 1)));

  const champSummary = winners.map(w => `${w.playerName}${w.score ? ` (${w.score})` : ""}`).join(", ");

  const players = await db
    .select({ id: playersTable.id, userId: playersTable.userId, email: playersTable.email, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, championship.tournamentId!));

  const userIds = players.filter(p => p.userId).map(p => p.userId!);
  const recipients = players.map(p => ({
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    userId: p.userId,
  }));

  const subject = `${championship.title} ${championship.year} – Results`;
  const body = `The ${championship.title} ${championship.year} results are in!\n\n${champSummary ? `Champions: ${champSummary}\n\n` : ""}Visit the Honours Board to see full results.`;

  const stats = await sendBroadcast(recipients, {
    subject,
    body,
    channels: ["email", "push"],
    eventName: "championship_results",
    tournamentId: championship.tournamentId,
    logoUrl: championship.orgLogo,
    primaryColor: championship.orgColor,
    // Task #1566 — tag club-championship results emails with the
    // originating org so the Postmark bounce webhook (Task #981) can
    // attribute hard bounces back to this club instantly.
    organizationId: orgId,
  });

  await db.insert(messageLogsTable).values({
    organizationId: orgId,
    tournamentId: championship.tournamentId,
    subject,
    body,
    channels: ["email", "push"],
    recipientCount: recipients.length,
    templateKey: "championship_results",
    status: "sent",
    deliveryStats: stats,
  });

  res.json({ success: true, recipientCount: recipients.length, stats });
});

export default router;
