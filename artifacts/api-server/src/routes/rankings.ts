/**
 * National & Regional Rankings API (Task #98)
 *
 * Series Management (org admin):
 * GET    /organizations/:orgId/rankings/series               List series
 * POST   /organizations/:orgId/rankings/series               Create series
 * GET    /organizations/:orgId/rankings/series/:seriesId     Get series detail
 * PATCH  /organizations/:orgId/rankings/series/:seriesId     Update series
 * DELETE /organizations/:orgId/rankings/series/:seriesId     Delete series
 *
 * Points Table:
 * GET    /organizations/:orgId/rankings/series/:seriesId/points-table
 * PUT    /organizations/:orgId/rankings/series/:seriesId/points-table
 *
 * Event Enrollment:
 * GET    /organizations/:orgId/rankings/series/:seriesId/events
 * POST   /organizations/:orgId/rankings/series/:seriesId/events
 * DELETE /organizations/:orgId/rankings/series/:seriesId/events/:enrollmentId
 *
 * Standings (public read):
 * GET    /organizations/:orgId/rankings/series/:seriesId/standings
 *
 * Archive:
 * POST   /organizations/:orgId/rankings/series/:seriesId/archive
 * GET    /organizations/:orgId/rankings/series/:seriesId/snapshots
 *
 * Points recalculation (admin):
 * POST   /organizations/:orgId/rankings/series/:seriesId/recalculate
 *
 * Public (no auth):
 * GET    /public/rankings/series/:seriesId/standings
 *
 * Player points history (portal):
 * GET    /portal/rankings/history
 */

import { Router, type Request, type Response } from "express";
import {
  db,
  rankingSeriesTable,
  pointsTableTable,
  seriesEventEnrollmentTable,
  rankingEntryTable,
  rankingPointsHistoryTable,
  rankingSnapshotTable,
  tournamentsTable,
  playersTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, asc, sql, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router = Router({ mergeParams: true });

// ── helpers ───────────────────────────────────────────────────────────────────

type PortalReq = { portalUser?: { userId?: number } };

function getPortalUserId(req: Request): number | null {
  return (req as unknown as PortalReq).portalUser?.userId ?? null;
}

function getAdminUserId(req: Request): number | null {
  if (req.isAuthenticated()) {
    const user = req.user as unknown as { id?: number };
    return user?.id ?? null;
  }
  return null;
}

// ── Points engine ─────────────────────────────────────────────────────────────

/**
 * Award ranking points for a single enrolled event.
 * Idempotent — deletes existing history rows before re-inserting.
 */
async function awardPointsForEvent(
  seriesId: number,
  tournamentId: number,
  enrollmentCategory: string,
  pointsMultiplier: number,
) {
  // Fetch points table
  const ptRows = await db
    .select()
    .from(pointsTableTable)
    .where(eq(pointsTableTable.seriesId, seriesId))
    .orderBy(asc(pointsTableTable.position));

  if (ptRows.length === 0) return;

  const pointsMap = new Map<number, number>(ptRows.map((r) => [r.position, r.points]));
  const maxPosition = Math.max(...ptRows.map((r) => r.position));

  // Fetch the series to know tiebreaker strategy
  const [series] = await db
    .select({ tiebreaker: rankingSeriesTable.tiebreaker })
    .from(rankingSeriesTable)
    .where(eq(rankingSeriesTable.id, seriesId));

  if (!series) return;

  // Fetch leaderboard positions from tournament players ordered by finishing position.
  // We order by gross score (or stableford descending) as an approximation of finishing position.
  // In a complete implementation the tournament leaderboard endpoint would supply final positions;
  // here we derive them from existing player data.
  const playersRows = await db
    .select({
      id: playersTable.id,
      userId: playersTable.userId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
    })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  if (playersRows.length === 0) return;

  // Compute finishing positions from leaderboard scores
  const finishingPositions = await computeFinishingPositions(tournamentId, playersRows);

  // Remove existing history rows for this series+tournament to allow idempotent recalculation
  const existingEntries = await db
    .select({ id: rankingEntryTable.id })
    .from(rankingEntryTable)
    .where(eq(rankingEntryTable.seriesId, seriesId));

  if (existingEntries.length > 0) {
    await db
      .delete(rankingPointsHistoryTable)
      .where(
        and(
          eq(rankingPointsHistoryTable.seriesId, seriesId),
          eq(rankingPointsHistoryTable.tournamentId, tournamentId),
        ),
      );
  }

  for (const fp of finishingPositions) {
    const player = playersRows.find((p) => p.id === fp.playerId);
    if (!player) continue;

    const basePoints = pointsMap.get(fp.position) ?? (fp.position <= maxPosition ? pointsMap.get(maxPosition) ?? 0 : 0);
    const pointsAwarded = Math.round(basePoints * pointsMultiplier);

    const category = enrollmentCategory as "open" | "men" | "ladies" | "seniors" | "juniors";
    const playerName = `${player.firstName} ${player.lastName}`;

    let entry: typeof rankingEntryTable.$inferSelect | null = null;

    if (player.userId) {
      // Try to find existing entry by userId
      const [existing] = await db
        .select()
        .from(rankingEntryTable)
        .where(
          and(
            eq(rankingEntryTable.seriesId, seriesId),
            eq(rankingEntryTable.userId, player.userId),
            eq(rankingEntryTable.category, category),
          ),
        );
      if (existing) {
        entry = existing;
      } else {
        const [newEntry] = await db
          .insert(rankingEntryTable)
          .values({
            seriesId,
            userId: player.userId,
            playerName,
            playerEmail: player.email,
            category,
          })
          .returning();
        entry = newEntry;
      }
    } else {
      // Guest player — match by name+email
      const nameMatches = await db
        .select()
        .from(rankingEntryTable)
        .where(
          and(
            eq(rankingEntryTable.seriesId, seriesId),
            eq(rankingEntryTable.playerName, playerName),
            eq(rankingEntryTable.category, category),
          ),
        );
      if (nameMatches.length > 0) {
        entry = nameMatches[0];
      } else {
        const [newEntry] = await db
          .insert(rankingEntryTable)
          .values({
            seriesId,
            userId: null,
            playerName,
            playerEmail: player.email ?? null,
            category,
          })
          .returning();
        entry = newEntry;
      }
    }

    if (!entry) continue;

    await db.insert(rankingPointsHistoryTable).values({
      seriesId,
      rankingEntryId: entry.id,
      tournamentId,
      position: fp.position,
      basePoints,
      multiplier: String(pointsMultiplier),
      pointsAwarded,
    }).onConflictDoUpdate({
      target: [rankingPointsHistoryTable.rankingEntryId, rankingPointsHistoryTable.tournamentId],
      set: {
        position: fp.position,
        basePoints,
        multiplier: String(pointsMultiplier),
        pointsAwarded,
      },
    });
  }

  // Recompute totals for all entries in this series
  await recomputeSeriesTotals(seriesId);
}

async function computeFinishingPositions(
  tournamentId: number,
  players: { id: number }[],
): Promise<{ playerId: number; position: number }[]> {
  // Pull gross totals per player from scores table
  const scoreTotals = await db.execute<{ player_id: number; total: number }>(
    sql`
      SELECT player_id, SUM(strokes) AS total
      FROM scores
      WHERE tournament_id = ${tournamentId}
      GROUP BY player_id
      ORDER BY total ASC
    `,
  );

  const rows = scoreTotals.rows as { player_id: number; total: number }[];
  const positions: { playerId: number; position: number }[] = [];

  // Players with scores get ranked; players without scores get last position
  let pos = 1;
  for (const row of rows) {
    positions.push({ playerId: Number(row.player_id), position: pos++ });
  }

  const scoredPlayerIds = new Set(rows.map((r) => Number(r.player_id)));
  const lastPos = pos;
  for (const p of players) {
    if (!scoredPlayerIds.has(p.id)) {
      positions.push({ playerId: p.id, position: lastPos });
    }
  }

  return positions;
}

async function recomputeSeriesTotals(seriesId: number): Promise<void> {
  // Aggregate points history per entry
  const aggregates = await db.execute<{
    ranking_entry_id: number;
    total_points: number;
    events_played: number;
    wins: number;
    runner_ups: number;
    top3: number;
  }>(
    sql`
      SELECT
        ranking_entry_id,
        COALESCE(SUM(points_awarded), 0) AS total_points,
        COUNT(*) AS events_played,
        COUNT(*) FILTER (WHERE position = 1) AS wins,
        COUNT(*) FILTER (WHERE position = 2) AS runner_ups,
        COUNT(*) FILTER (WHERE position <= 3) AS top3
      FROM ranking_points_history
      WHERE series_id = ${seriesId}
      GROUP BY ranking_entry_id
    `,
  );

  for (const agg of aggregates.rows as { ranking_entry_id: number; total_points: number; events_played: number; wins: number; runner_ups: number; top3: number }[]) {
    await db
      .update(rankingEntryTable)
      .set({
        totalPoints: Number(agg.total_points),
        eventsPlayed: Number(agg.events_played),
        wins: Number(agg.wins),
        runnerUps: Number(agg.runner_ups),
        top3: Number(agg.top3),
        updatedAt: new Date(),
      })
      .where(eq(rankingEntryTable.id, Number(agg.ranking_entry_id)));
  }

  // Re-rank within each category
  const entries = await db
    .select()
    .from(rankingEntryTable)
    .where(eq(rankingEntryTable.seriesId, seriesId));

  // Group by category
  const byCategory = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category)!.push(e);
  }

  for (const [, catEntries] of byCategory) {
    // Sort by total points desc, then tiebreakers
    const [{ tiebreaker }] = (await db
      .select({ tiebreaker: rankingSeriesTable.tiebreaker })
      .from(rankingSeriesTable)
      .where(eq(rankingSeriesTable.id, seriesId)));

    catEntries.sort((a, b) => {
      const ptsDiff = b.totalPoints - a.totalPoints;
      if (ptsDiff !== 0) return ptsDiff;
      if (tiebreaker === "most_wins") return b.wins - a.wins;
      if (tiebreaker === "most_runner_up") return b.runnerUps - a.runnerUps;
      if (tiebreaker === "most_top3") return b.top3 - a.top3;
      return 0;
    });

    let pos = 1;
    for (const e of catEntries) {
      await db
        .update(rankingEntryTable)
        .set({ position: pos++ })
        .where(eq(rankingEntryTable.id, e.id));
    }
  }
}

// ── Series CRUD ───────────────────────────────────────────────────────────────

// GET /organizations/:orgId/rankings/series
router.get("/series", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const series = await db
    .select()
    .from(rankingSeriesTable)
    .where(eq(rankingSeriesTable.organizationId, orgId))
    .orderBy(desc(rankingSeriesTable.createdAt));

  res.json(series);
});

// POST /organizations/:orgId/rankings/series
router.post("/series", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const userId = getAdminUserId(req);
  const { name, description, level, seasonStart, seasonEnd, tiebreaker, isPublic } = req.body;

  if (!name || !seasonStart || !seasonEnd) {
    res.status(400).json({ error: "name, seasonStart, and seasonEnd are required" });
    return;
  }

  const [series] = await db
    .insert(rankingSeriesTable)
    .values({
      organizationId: orgId,
      name,
      description: description ?? null,
      level: level ?? "club",
      status: "draft",
      seasonStart: new Date(seasonStart),
      seasonEnd: new Date(seasonEnd),
      tiebreaker: tiebreaker ?? "most_wins",
      isPublic: isPublic ?? true,
      createdBy: userId,
    })
    .returning();

  res.status(201).json(series);
});

// GET /organizations/:orgId/rankings/series/:seriesId
router.get("/series/:seriesId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));

  const [series] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  const ptRows = await db
    .select()
    .from(pointsTableTable)
    .where(eq(pointsTableTable.seriesId, seriesId))
    .orderBy(asc(pointsTableTable.position));

  const events = await db
    .select({
      id: seriesEventEnrollmentTable.id,
      tournamentId: seriesEventEnrollmentTable.tournamentId,
      category: seriesEventEnrollmentTable.category,
      pointsMultiplier: seriesEventEnrollmentTable.pointsMultiplier,
      enrolledAt: seriesEventEnrollmentTable.enrolledAt,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
      tournamentDate: tournamentsTable.startDate,
    })
    .from(seriesEventEnrollmentTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, seriesEventEnrollmentTable.tournamentId))
    .where(eq(seriesEventEnrollmentTable.seriesId, seriesId))
    .orderBy(asc(tournamentsTable.startDate));

  res.json({ ...series, pointsTable: ptRows, events });
});

// PATCH /organizations/:orgId/rankings/series/:seriesId
router.patch("/series/:seriesId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, level, status, seasonStart, seasonEnd, tiebreaker, isPublic } = req.body;

  const [existing] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!existing) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  const [updated] = await db
    .update(rankingSeriesTable)
    .set({
      name: name ?? existing.name,
      description: description !== undefined ? description : existing.description,
      level: level ?? existing.level,
      status: status ?? existing.status,
      seasonStart: seasonStart ? new Date(seasonStart) : existing.seasonStart,
      seasonEnd: seasonEnd ? new Date(seasonEnd) : existing.seasonEnd,
      tiebreaker: tiebreaker ?? existing.tiebreaker,
      isPublic: isPublic !== undefined ? isPublic : existing.isPublic,
      updatedAt: new Date(),
    })
    .where(eq(rankingSeriesTable.id, seriesId))
    .returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/rankings/series/:seriesId
router.delete("/series/:seriesId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db
    .delete(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  res.json({ success: true });
});

// ── Points Table ──────────────────────────────────────────────────────────────

// GET /organizations/:orgId/rankings/series/:seriesId/points-table
router.get("/series/:seriesId/points-table", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));

  const [series] = await db
    .select({ id: rankingSeriesTable.id })
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  const rows = await db
    .select()
    .from(pointsTableTable)
    .where(eq(pointsTableTable.seriesId, seriesId))
    .orderBy(asc(pointsTableTable.position));

  res.json(rows);
});

// PUT /organizations/:orgId/rankings/series/:seriesId/points-table
router.put("/series/:seriesId/points-table", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { entries } = req.body as { entries: { position: number; points: number }[] };

  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "entries must be a non-empty array of {position, points}" });
    return;
  }

  const [series] = await db
    .select({ id: rankingSeriesTable.id })
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  // Replace all entries
  await db.delete(pointsTableTable).where(eq(pointsTableTable.seriesId, seriesId));

  const inserted = await db
    .insert(pointsTableTable)
    .values(entries.map((e) => ({ seriesId, position: e.position, points: e.points })))
    .returning();

  res.json(inserted);
});

// ── Event Enrollment ──────────────────────────────────────────────────────────

// GET /organizations/:orgId/rankings/series/:seriesId/events
router.get("/series/:seriesId/events", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));

  const events = await db
    .select({
      id: seriesEventEnrollmentTable.id,
      tournamentId: seriesEventEnrollmentTable.tournamentId,
      category: seriesEventEnrollmentTable.category,
      pointsMultiplier: seriesEventEnrollmentTable.pointsMultiplier,
      enrolledAt: seriesEventEnrollmentTable.enrolledAt,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
      tournamentDate: tournamentsTable.startDate,
    })
    .from(seriesEventEnrollmentTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, seriesEventEnrollmentTable.tournamentId))
    .where(
      and(
        eq(seriesEventEnrollmentTable.seriesId, seriesId),
        eq(tournamentsTable.organizationId, orgId),
      ),
    )
    .orderBy(asc(tournamentsTable.startDate));

  res.json(events);
});

// POST /organizations/:orgId/rankings/series/:seriesId/events
router.post("/series/:seriesId/events", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { tournamentId, category, pointsMultiplier } = req.body;

  if (!tournamentId) {
    res.status(400).json({ error: "tournamentId is required" });
    return;
  }

  // Verify tournament belongs to org
  const [tournament] = await db
    .select({ id: tournamentsTable.id, status: tournamentsTable.status })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const [enrollment] = await db
    .insert(seriesEventEnrollmentTable)
    .values({
      seriesId,
      tournamentId,
      category: category ?? "open",
      pointsMultiplier: pointsMultiplier ? String(pointsMultiplier) : "1.00",
    })
    .onConflictDoUpdate({
      target: [seriesEventEnrollmentTable.seriesId, seriesEventEnrollmentTable.tournamentId],
      set: {
        category: category ?? "open",
        pointsMultiplier: pointsMultiplier ? String(pointsMultiplier) : "1.00",
      },
    })
    .returning();

  // If the tournament is already completed, auto-award points
  if (tournament.status === "completed") {
    await awardPointsForEvent(
      seriesId,
      tournamentId,
      category ?? "open",
      parseFloat(pointsMultiplier ?? "1.00"),
    ).catch(() => {/* non-fatal */});
  }

  res.status(201).json(enrollment);
});

// DELETE /organizations/:orgId/rankings/series/:seriesId/events/:enrollmentId
router.delete("/series/:seriesId/events/:enrollmentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  const enrollmentId = parseInt(String((req.params as Record<string, string>).enrollmentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [enrollment] = await db
    .select()
    .from(seriesEventEnrollmentTable)
    .where(
      and(
        eq(seriesEventEnrollmentTable.id, enrollmentId),
        eq(seriesEventEnrollmentTable.seriesId, seriesId),
      ),
    );

  if (!enrollment) {
    res.status(404).json({ error: "Enrollment not found" });
    return;
  }

  await db.delete(seriesEventEnrollmentTable).where(eq(seriesEventEnrollmentTable.id, enrollmentId));

  // Remove history for this event and recompute
  const entries = await db
    .select({ id: rankingEntryTable.id })
    .from(rankingEntryTable)
    .where(eq(rankingEntryTable.seriesId, seriesId));

  if (entries.length > 0) {
    await db
      .delete(rankingPointsHistoryTable)
      .where(
        and(
          eq(rankingPointsHistoryTable.seriesId, seriesId),
          eq(rankingPointsHistoryTable.tournamentId, enrollment.tournamentId),
        ),
      );
    await recomputeSeriesTotals(seriesId);
  }

  res.json({ success: true });
});

// ── Standings ─────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/rankings/series/:seriesId/standings
router.get("/series/:seriesId/standings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  const { category } = req.query;

  const [series] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  let query = db
    .select({
      id: rankingEntryTable.id,
      userId: rankingEntryTable.userId,
      playerName: rankingEntryTable.playerName,
      category: rankingEntryTable.category,
      totalPoints: rankingEntryTable.totalPoints,
      eventsPlayed: rankingEntryTable.eventsPlayed,
      wins: rankingEntryTable.wins,
      runnerUps: rankingEntryTable.runnerUps,
      top3: rankingEntryTable.top3,
      position: rankingEntryTable.position,
      profileImage: appUsersTable.profileImage,
      displayName: appUsersTable.displayName,
    })
    .from(rankingEntryTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, rankingEntryTable.userId))
    .where(
      category
        ? and(
          eq(rankingEntryTable.seriesId, seriesId),
          eq(rankingEntryTable.category, category as never),
        )
        : eq(rankingEntryTable.seriesId, seriesId),
    )
    .orderBy(asc(rankingEntryTable.position), desc(rankingEntryTable.totalPoints))
    .$dynamic();

  const entries = await query;

  res.json({ series, entries });
});

// ── Recalculate ───────────────────────────────────────────────────────────────

// POST /organizations/:orgId/rankings/series/:seriesId/recalculate
router.post("/series/:seriesId/recalculate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [series] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  const enrollments = await db
    .select()
    .from(seriesEventEnrollmentTable)
    .where(eq(seriesEventEnrollmentTable.seriesId, seriesId));

  // Only process completed tournaments
  const completedEnrollments = [];
  for (const e of enrollments) {
    const [t] = await db
      .select({ status: tournamentsTable.status })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, e.tournamentId));
    if (t?.status === "completed") completedEnrollments.push(e);
  }

  // Reset all entries
  await db.delete(rankingPointsHistoryTable).where(eq(rankingPointsHistoryTable.seriesId, seriesId));
  await db.update(rankingEntryTable).set({
    totalPoints: 0, eventsPlayed: 0, wins: 0, runnerUps: 0, top3: 0, position: null,
  }).where(eq(rankingEntryTable.seriesId, seriesId));

  // Re-award for each completed event
  for (const e of completedEnrollments) {
    await awardPointsForEvent(
      seriesId,
      e.tournamentId,
      e.category,
      parseFloat(e.pointsMultiplier ?? "1.00"),
    ).catch(() => {/* non-fatal */});
  }

  res.json({ success: true, eventsProcessed: completedEnrollments.length });
});

// ── Archive / Snapshot ────────────────────────────────────────────────────────

// POST /organizations/:orgId/rankings/series/:seriesId/archive
router.post("/series/:seriesId/archive", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const userId = getAdminUserId(req);

  const [series] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.organizationId, orgId)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  // Fetch current standings for snapshot
  const entries = await db
    .select()
    .from(rankingEntryTable)
    .where(eq(rankingEntryTable.seriesId, seriesId))
    .orderBy(asc(rankingEntryTable.position));

  const snapshotData = entries.map((e) => ({
    position: e.position ?? 0,
    playerName: e.playerName,
    userId: e.userId,
    category: e.category,
    totalPoints: e.totalPoints,
    eventsPlayed: e.eventsPlayed,
    wins: e.wins,
    runnerUps: e.runnerUps,
    top3: e.top3,
  }));

  const [snapshot] = await db
    .insert(rankingSnapshotTable)
    .values({ seriesId, snapshotData, archivedBy: userId })
    .returning();

  // Mark series as archived
  await db
    .update(rankingSeriesTable)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(rankingSeriesTable.id, seriesId));

  res.status(201).json(snapshot);
});

// GET /organizations/:orgId/rankings/series/:seriesId/snapshots
router.get("/series/:seriesId/snapshots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));

  const snapshots = await db
    .select()
    .from(rankingSnapshotTable)
    .where(eq(rankingSnapshotTable.seriesId, seriesId))
    .orderBy(desc(rankingSnapshotTable.archivedAt));

  res.json(snapshots);
});

export default router;

// ── Separate public router (no auth) ──────────────────────────────────────────

export const publicRankingsRouter = Router({ mergeParams: true });

// GET /public/rankings/series/:seriesId/standings
publicRankingsRouter.get("/rankings/series/:seriesId/standings", async (req: Request, res: Response) => {
  const seriesId = parseInt(String((req.params as Record<string, string>).seriesId));
  const { category } = req.query;

  const [series] = await db
    .select()
    .from(rankingSeriesTable)
    .where(and(eq(rankingSeriesTable.id, seriesId), eq(rankingSeriesTable.isPublic, true)));

  if (!series) {
    res.status(404).json({ error: "Series not found" });
    return;
  }

  const entries = await db
    .select({
      id: rankingEntryTable.id,
      userId: rankingEntryTable.userId,
      playerName: rankingEntryTable.playerName,
      category: rankingEntryTable.category,
      totalPoints: rankingEntryTable.totalPoints,
      eventsPlayed: rankingEntryTable.eventsPlayed,
      wins: rankingEntryTable.wins,
      runnerUps: rankingEntryTable.runnerUps,
      top3: rankingEntryTable.top3,
      position: rankingEntryTable.position,
      profileImage: appUsersTable.profileImage,
      displayName: appUsersTable.displayName,
    })
    .from(rankingEntryTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, rankingEntryTable.userId))
    .where(
      category
        ? and(
          eq(rankingEntryTable.seriesId, seriesId),
          eq(rankingEntryTable.category, category as never),
        )
        : eq(rankingEntryTable.seriesId, seriesId),
    )
    .orderBy(asc(rankingEntryTable.position), desc(rankingEntryTable.totalPoints));

  res.json({ series, entries });
});

// GET /public/rankings  - list all public active series
publicRankingsRouter.get("/rankings", async (req: Request, res: Response) => {
  const series = await db
    .select()
    .from(rankingSeriesTable)
    .where(
      and(
        eq(rankingSeriesTable.isPublic, true),
        eq(rankingSeriesTable.status, "active"),
      ),
    )
    .orderBy(desc(rankingSeriesTable.createdAt));

  res.json(series);
});

// ── Portal router (player points history) ────────────────────────────────────

export const portalRankingsRouter = Router({ mergeParams: true });

// GET /portal/rankings/history
portalRankingsRouter.get("/rankings/history", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);

  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Find all ranking entries for this user
  const entries = await db
    .select({
      id: rankingEntryTable.id,
      seriesId: rankingEntryTable.seriesId,
      category: rankingEntryTable.category,
      totalPoints: rankingEntryTable.totalPoints,
      eventsPlayed: rankingEntryTable.eventsPlayed,
      wins: rankingEntryTable.wins,
      runnerUps: rankingEntryTable.runnerUps,
      top3: rankingEntryTable.top3,
      position: rankingEntryTable.position,
      seriesName: rankingSeriesTable.name,
      seriesLevel: rankingSeriesTable.level,
      seriesStatus: rankingSeriesTable.status,
      seasonStart: rankingSeriesTable.seasonStart,
      seasonEnd: rankingSeriesTable.seasonEnd,
    })
    .from(rankingEntryTable)
    .leftJoin(rankingSeriesTable, eq(rankingSeriesTable.id, rankingEntryTable.seriesId))
    .where(eq(rankingEntryTable.userId, userId))
    .orderBy(desc(rankingSeriesTable.seasonStart));

  // For each entry get the points history
  const result = await Promise.all(
    entries.map(async (entry) => {
      const history = await db
        .select({
          id: rankingPointsHistoryTable.id,
          tournamentId: rankingPointsHistoryTable.tournamentId,
          position: rankingPointsHistoryTable.position,
          pointsAwarded: rankingPointsHistoryTable.pointsAwarded,
          awardedAt: rankingPointsHistoryTable.awardedAt,
          tournamentName: tournamentsTable.name,
          tournamentDate: tournamentsTable.startDate,
        })
        .from(rankingPointsHistoryTable)
        .leftJoin(tournamentsTable, eq(tournamentsTable.id, rankingPointsHistoryTable.tournamentId))
        .where(eq(rankingPointsHistoryTable.rankingEntryId, entry.id))
        .orderBy(desc(rankingPointsHistoryTable.awardedAt));
      return { ...entry, history };
    }),
  );

  res.json(result);
});

// Export the auto-award function for use in tournament finalization
export { awardPointsForEvent };
