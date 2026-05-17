import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  interclubSeasonTable,
  interclubFixtureFullTable,
  interclubRosterTable,
  interclubMatchTable,
  organizationsTable,
  messageLogsTable,
  appUsersTable,
  clubMembersTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendBroadcast } from "../lib/comms";

const router: IRouter = Router({ mergeParams: true });

// ─── INTERCLUB SEASONS ────────────────────────────────────────────────────────

// GET /organizations/:orgId/interclub/seasons
router.get("/seasons", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seasons = await db
    .select()
    .from(interclubSeasonTable)
    .where(eq(interclubSeasonTable.organizationId, orgId))
    .orderBy(desc(interclubSeasonTable.year));

  res.json(seasons);
});

// POST /organizations/:orgId/interclub/seasons
router.post("/seasons", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, year, description } = req.body;
  if (!name || !year) {
    res.status(400).json({ error: "name and year are required" });
    return;
  }

  const [season] = await db
    .insert(interclubSeasonTable)
    .values({ organizationId: orgId, name, year: parseInt(year), description: description ?? null })
    .returning();

  res.status(201).json(season);
});

// PATCH /organizations/:orgId/interclub/seasons/:seasonId
router.patch("/seasons/:seasonId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seasonId = parseInt(String((req.params as Record<string, string>).seasonId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, status } = req.body;

  const [updated] = await db
    .update(interclubSeasonTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(interclubSeasonTable.id, seasonId), eq(interclubSeasonTable.organizationId, orgId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Season not found" });
    return;
  }

  res.json(updated);
});

// DELETE /organizations/:orgId/interclub/seasons/:seasonId
router.delete("/seasons/:seasonId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seasonId = parseInt(String((req.params as Record<string, string>).seasonId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(interclubSeasonTable)
    .where(and(eq(interclubSeasonTable.id, seasonId), eq(interclubSeasonTable.organizationId, orgId)));

  res.status(204).end();
});

// GET /organizations/:orgId/interclub/seasons/:seasonId/standings
router.get("/seasons/:seasonId/standings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seasonId = parseInt(String((req.params as Record<string, string>).seasonId));

  const fixtures = await db
    .select()
    .from(interclubFixtureFullTable)
    .where(and(
      eq(interclubFixtureFullTable.organizationId, orgId),
      eq(interclubFixtureFullTable.seasonId, seasonId),
    ))
    .orderBy(asc(interclubFixtureFullTable.fixtureDate));

  const standingsMap: Record<string, { opponent: string; played: number; won: number; drawn: number; lost: number; pts: number }> = {};
  for (const f of fixtures) {
    if (f.status !== "completed") continue;
    const opp = f.opponentName;
    if (!standingsMap[opp]) standingsMap[opp] = { opponent: opp, played: 0, won: 0, drawn: 0, lost: 0, pts: 0 };
    standingsMap[opp].played += 1;

    const hp = parseFloat(f.homePoints?.toString() ?? "0");
    const ap = parseFloat(f.awayPoints?.toString() ?? "0");

    if (hp > ap) {
      standingsMap[opp].won += 1;
      standingsMap[opp].pts += 2;
    } else if (ap > hp) {
      standingsMap[opp].lost += 1;
    } else if (hp === ap) {
      standingsMap[opp].drawn += 1;
      standingsMap[opp].pts += 1;
    }
  }

  const summary = {
    played: fixtures.filter(f => f.status === "completed").length,
    won: fixtures.filter(f => f.status === "completed" && parseFloat(f.homePoints?.toString() ?? "0") > parseFloat(f.awayPoints?.toString() ?? "0")).length,
    drawn: fixtures.filter(f => f.status === "completed" && f.homePoints?.toString() === f.awayPoints?.toString()).length,
    lost: fixtures.filter(f => f.status === "completed" && parseFloat(f.homePoints?.toString() ?? "0") < parseFloat(f.awayPoints?.toString() ?? "0")).length,
  };

  res.json({ fixtures, opponents: Object.values(standingsMap), summary });
});

// ─── INTERCLUB FIXTURES ───────────────────────────────────────────────────────

// GET /organizations/:orgId/interclub/fixtures
router.get("/fixtures", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { seasonId } = req.query;

  const conditions = [eq(interclubFixtureFullTable.organizationId, orgId)];
  if (seasonId) conditions.push(eq(interclubFixtureFullTable.seasonId, parseInt(seasonId as string)));

  const fixtures = await db
    .select()
    .from(interclubFixtureFullTable)
    .where(and(...conditions))
    .orderBy(asc(interclubFixtureFullTable.fixtureDate));

  res.json(fixtures);
});

// GET /organizations/:orgId/interclub/fixtures/:fixtureId
router.get("/fixtures/:fixtureId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));

  const [fixture] = await db
    .select()
    .from(interclubFixtureFullTable)
    .where(and(eq(interclubFixtureFullTable.id, fixtureId), eq(interclubFixtureFullTable.organizationId, orgId)));

  if (!fixture) {
    res.status(404).json({ error: "Fixture not found" });
    return;
  }

  const [roster, matches] = await Promise.all([
    db.select().from(interclubRosterTable).where(eq(interclubRosterTable.fixtureId, fixtureId)).orderBy(asc(interclubRosterTable.position)),
    db.select().from(interclubMatchTable).where(eq(interclubMatchTable.fixtureId, fixtureId)).orderBy(asc(interclubMatchTable.matchNumber)),
  ]);

  res.json({ ...fixture, roster, matches });
});

// POST /organizations/:orgId/interclub/fixtures
router.post("/fixtures", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { opponentName, opponentClub, fixtureDate, venue, isHome, format, seasonId, notes } = req.body;
  if (!opponentName) {
    res.status(400).json({ error: "opponentName is required" });
    return;
  }

  const [fixture] = await db
    .insert(interclubFixtureFullTable)
    .values({
      organizationId: orgId,
      opponentName,
      opponentClub: opponentClub ?? null,
      fixtureDate: fixtureDate ? new Date(fixtureDate) : null,
      venue: venue ?? null,
      isHome: isHome ?? true,
      format: format ?? "matchplay",
      seasonId: seasonId ? parseInt(seasonId) : null,
      notes: notes ?? null,
    })
    .returning();

  res.status(201).json(fixture);
});

// PATCH /organizations/:orgId/interclub/fixtures/:fixtureId
router.patch("/fixtures/:fixtureId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { opponentName, opponentClub, fixtureDate, venue, isHome, format, status, homePoints, awayPoints, result, notes, seasonId } = req.body;

  const [updated] = await db
    .update(interclubFixtureFullTable)
    .set({
      ...(opponentName !== undefined ? { opponentName } : {}),
      ...(opponentClub !== undefined ? { opponentClub } : {}),
      ...(fixtureDate !== undefined ? { fixtureDate: fixtureDate ? new Date(fixtureDate) : null } : {}),
      ...(venue !== undefined ? { venue } : {}),
      ...(isHome !== undefined ? { isHome } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(homePoints !== undefined ? { homePoints: homePoints !== null ? String(homePoints) : null } : {}),
      ...(awayPoints !== undefined ? { awayPoints: awayPoints !== null ? String(awayPoints) : null } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(seasonId !== undefined ? { seasonId: seasonId ? parseInt(seasonId) : null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(interclubFixtureFullTable.id, fixtureId), eq(interclubFixtureFullTable.organizationId, orgId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Fixture not found" });
    return;
  }

  res.json(updated);
});

// DELETE /organizations/:orgId/interclub/fixtures/:fixtureId
router.delete("/fixtures/:fixtureId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(interclubFixtureFullTable)
    .where(and(eq(interclubFixtureFullTable.id, fixtureId), eq(interclubFixtureFullTable.organizationId, orgId)));

  res.status(204).end();
});

// ─── INTERCLUB ROSTER ─────────────────────────────────────────────────────────

// POST /organizations/:orgId/interclub/fixtures/:fixtureId/roster
router.post("/fixtures/:fixtureId/roster", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { side, playerName, playerId, userId, handicapIndex, position } = req.body;
  if (!playerName || !side) {
    res.status(400).json({ error: "playerName and side are required" });
    return;
  }

  const [entry] = await db
    .insert(interclubRosterTable)
    .values({
      fixtureId,
      side,
      playerName,
      playerId: playerId ? parseInt(playerId) : null,
      userId: userId ? parseInt(userId) : null,
      handicapIndex: handicapIndex ? String(handicapIndex) : null,
      position: position ?? 0,
    })
    .returning();

  res.status(201).json(entry);
});

// PATCH /organizations/:orgId/interclub/fixtures/:fixtureId/roster/:rosterId
router.patch("/fixtures/:fixtureId/roster/:rosterId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { playerName, side, handicapIndex, position } = req.body;

  const [updated] = await db
    .update(interclubRosterTable)
    .set({
      ...(playerName !== undefined ? { playerName } : {}),
      ...(side !== undefined ? { side } : {}),
      ...(handicapIndex !== undefined ? { handicapIndex: handicapIndex ? String(handicapIndex) : null } : {}),
      ...(position !== undefined ? { position } : {}),
    })
    .where(eq(interclubRosterTable.id, rosterId))
    .returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/interclub/fixtures/:fixtureId/roster/:rosterId
router.delete("/fixtures/:fixtureId/roster/:rosterId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(interclubRosterTable).where(eq(interclubRosterTable.id, rosterId));
  res.status(204).end();
});

// ─── INTERCLUB MATCHES ────────────────────────────────────────────────────────

// POST /organizations/:orgId/interclub/fixtures/:fixtureId/matches
router.post("/fixtures/:fixtureId/matches", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { matchNumber, homePlayerName, homePlayerId, awayPlayerName, awayPlayerId, result, homePoints, awayPoints, holesPlayed, notes } = req.body;

  if (!homePlayerName || !awayPlayerName) {
    res.status(400).json({ error: "homePlayerName and awayPlayerName are required" });
    return;
  }

  const [match] = await db
    .insert(interclubMatchTable)
    .values({
      fixtureId,
      matchNumber: matchNumber ?? 1,
      homePlayerName,
      homePlayerId: homePlayerId ? parseInt(homePlayerId) : null,
      awayPlayerName,
      awayPlayerId: awayPlayerId ? parseInt(awayPlayerId) : null,
      result: result ?? "pending",
      homePoints: homePoints !== undefined ? String(homePoints) : null,
      awayPoints: awayPoints !== undefined ? String(awayPoints) : null,
      holesPlayed: holesPlayed ?? null,
      notes: notes ?? null,
    })
    .returning();

  res.status(201).json(match);
});

// PATCH /organizations/:orgId/interclub/fixtures/:fixtureId/matches/:matchId
router.patch("/fixtures/:fixtureId/matches/:matchId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const matchId = parseInt(String((req.params as Record<string, string>).matchId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { homePlayerName, awayPlayerName, result, homePoints, awayPoints, holesPlayed, notes } = req.body;

  const [updated] = await db
    .update(interclubMatchTable)
    .set({
      ...(homePlayerName !== undefined ? { homePlayerName } : {}),
      ...(awayPlayerName !== undefined ? { awayPlayerName } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(homePoints !== undefined ? { homePoints: homePoints !== null ? String(homePoints) : null } : {}),
      ...(awayPoints !== undefined ? { awayPoints: awayPoints !== null ? String(awayPoints) : null } : {}),
      ...(holesPlayed !== undefined ? { holesPlayed } : {}),
      ...(notes !== undefined ? { notes } : {}),
    })
    .where(eq(interclubMatchTable.id, matchId))
    .returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/interclub/fixtures/:fixtureId/matches/:matchId
router.delete("/fixtures/:fixtureId/matches/:matchId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const matchId = parseInt(String((req.params as Record<string, string>).matchId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(interclubMatchTable).where(eq(interclubMatchTable.id, matchId));
  res.status(204).end();
});

// ─── NOTIFY FIXTURE RESULT ────────────────────────────────────────────────────

// POST /organizations/:orgId/interclub/fixtures/:fixtureId/notify
router.post("/fixtures/:fixtureId/notify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [fixture] = await db
    .select({
      id: interclubFixtureFullTable.id,
      opponentName: interclubFixtureFullTable.opponentName,
      fixtureDate: interclubFixtureFullTable.fixtureDate,
      homePoints: interclubFixtureFullTable.homePoints,
      awayPoints: interclubFixtureFullTable.awayPoints,
      result: interclubFixtureFullTable.result,
      orgName: organizationsTable.name,
      orgLogo: organizationsTable.logoUrl,
      orgColor: organizationsTable.primaryColor,
    })
    .from(interclubFixtureFullTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, interclubFixtureFullTable.organizationId))
    .where(and(eq(interclubFixtureFullTable.id, fixtureId), eq(interclubFixtureFullTable.organizationId, orgId)));

  if (!fixture) {
    res.status(404).json({ error: "Fixture not found" });
    return;
  }

  const roster = await db
    .select({
      userId: interclubRosterTable.userId,
      playerName: interclubRosterTable.playerName,
    })
    .from(interclubRosterTable)
    .where(and(eq(interclubRosterTable.fixtureId, fixtureId), eq(interclubRosterTable.side, "home")));

  const members = await db
    .select({ email: appUsersTable.email, displayName: appUsersTable.displayName, id: appUsersTable.id })
    .from(appUsersTable)
    .where(eq(appUsersTable.organizationId, orgId));

  const recipients = members.map(m => ({
    email: m.email,
    firstName: m.displayName?.split(" ")[0] ?? "Member",
    lastName: m.displayName?.split(" ").slice(1).join(" ") ?? "",
    userId: m.id,
  }));

  const hp = parseFloat(fixture.homePoints?.toString() ?? "0");
  const ap = parseFloat(fixture.awayPoints?.toString() ?? "0");
  const resultText = fixture.result ?? (hp > ap ? "Win" : hp < ap ? "Loss" : "Draw");
  const scoreText = fixture.homePoints !== null ? `${fixture.homePoints} – ${fixture.awayPoints}` : "";

  const subject = `Interclub Result vs ${fixture.opponentName}`;
  const body = `Result: ${resultText}${scoreText ? ` (${scoreText})` : ""}\nOpponent: ${fixture.opponentName}`;

  const stats = await sendBroadcast(recipients, {
    subject,
    body,
    channels: ["email", "push"],
    eventName: "interclub_result",
    logoUrl: fixture.orgLogo,
    primaryColor: fixture.orgColor,
    // Task #1566 — tag interclub-result emails with the originating org so
    // the Postmark bounce webhook (Task #981) can attribute hard bounces
    // back to this club instantly.
    organizationId: orgId,
  });

  await db.insert(messageLogsTable).values({
    organizationId: orgId,
    subject,
    body,
    channels: ["email", "push"],
    recipientCount: recipients.length,
    templateKey: "interclub_result",
    status: "sent",
    deliveryStats: stats,
  });

  res.json({ success: true, recipientCount: recipients.length, stats });
});

export default router;
