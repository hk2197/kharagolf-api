import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { teeTimesTable, teeTimePlayersTable, playersTable, tournamentsTable, appUsersTable, scoresTable } from "@workspace/db";
import { eq, sql, and, inArray, sum, asc } from "drizzle-orm";
import { sendTransactionalPush } from "../lib/comms";
import { sendPairingsEmail } from "../lib/mailer";
import { notifyTournamentTeePublished } from "../lib/brandedNotifications";
import { GeneratePairingsBody } from "@workspace/api-zod";

const router: IRouter = Router({ mergeParams: true });

/**
 * Parse a single CSV line correctly, handling quoted fields that may contain commas.
 * Supports double-quote escaping ("" inside a quoted field → literal ").
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// GET /organizations/:orgId/tournaments/:tournamentId/tee-times
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimes = await db.select().from(teeTimesTable).where(eq(teeTimesTable.tournamentId, tournamentId)).orderBy(teeTimesTable.teeTime);

  const results = await Promise.all(
    teeTimes.map(async (tt) => {
      const ttPlayers = await db
        .select({
          playerId: teeTimePlayersTable.playerId,
          firstName: playersTable.firstName,
          lastName: playersTable.lastName,
          flight: playersTable.flight,
          handicapIndex: playersTable.handicapIndex,
        })
        .from(teeTimePlayersTable)
        .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
        .where(eq(teeTimePlayersTable.teeTimeId, tt.id));
      return { ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players: ttPlayers };
    }),
  );

  res.json(results);
});

// POST /organizations/:orgId/tournaments/:tournamentId/tee-times
router.post("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { teeTime, hole, round, playerIds } = req.body;

  if (!teeTime) {
    res.status(400).json({ error: "teeTime is required" });
    return;
  }

  const [tt] = await db
    .insert(teeTimesTable)
    .values({ tournamentId, round: round ?? 1, teeTime: new Date(teeTime), startingHole: hole ?? 1, isManual: true })
    .returning();

  if (playerIds?.length) {
    await db.insert(teeTimePlayersTable).values(
      playerIds.map((pid: number) => ({ teeTimeId: tt.id, playerId: pid })),
    );
  }

  const ttPlayers = await db
    .select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex, userId: playersTable.userId })
    .from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
    .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

  // Push notification: tee time assigned
  const teeTimeStr = tt.teeTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const userIds = ttPlayers.map(p => p.userId).filter((id): id is number => typeof id === "number" && id > 0);
  // Task #1240 — fire-and-forget (`.catch(() => undefined)`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendTransactionalPush(
    userIds,
    "Tee Time Assigned",
    `You are booked for ${teeTimeStr}, Hole ${tt.startingHole}, Round ${tt.round}.`,
    { type: "tee_time_assigned", teeTimeId: tt.id, tournamentId },
  ).catch(() => undefined);

  res.status(201).json({ ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players: ttPlayers });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/tee-times — bulk clear (one round or all), transactional
router.delete("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // If ?round= is provided it must parse to a positive integer; anything else (NaN, 0, negative) is rejected
  let roundParam: number | null = null;
  if (req.query.round !== undefined) {
    const parsed = parseInt(req.query.round as string, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      res.status(400).json({ error: "round query param must be a positive integer" });
      return;
    }
    roundParam = parsed;
  }

  const conditions = roundParam != null
    ? and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, roundParam))
    : eq(teeTimesTable.tournamentId, tournamentId);

  const times = await db.select({ id: teeTimesTable.id }).from(teeTimesTable).where(conditions);
  if (times.length > 0) {
    const ids = times.map(t => t.id);
    await db.transaction(async (tx) => {
      await tx.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, ids));
      await tx.delete(teeTimesTable).where(inArray(teeTimesTable.id, ids));
    });
  }

  res.json({ success: true, deleted: times.length });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/tee-times/bulk-set-times
// Bulk-assign sequential tee times to all groups in a round (after group creation)
// MUST be registered before PATCH /:teeTimeId to avoid route conflict
router.patch("/bulk-set-times", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { round, startTime, intervalMinutes, startingHole } = req.body;
  if (!startTime) {
    res.status(400).json({ error: "startTime is required" });
    return;
  }
  const iMinutes = intervalMinutes ?? 10;
  const hole = startingHole ?? 1;
  const roundNum = round ?? 1;

  const times = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, roundNum)))
    .orderBy(asc(teeTimesTable.teeTime));

  if (times.length === 0) {
    res.status(400).json({ error: "No tee times found for this round" });
    return;
  }

  const baseTime = new Date(startTime);
  const intervalMs = iMinutes * 60 * 1000;

  await db.transaction(async (tx) => {
    for (let i = 0; i < times.length; i++) {
      const newTime = new Date(baseTime.getTime() + i * intervalMs);
      await tx.update(teeTimesTable)
        .set({ teeTime: newTime, startingHole: hole })
        .where(eq(teeTimesTable.id, times[i].id));
    }
  });

  const updated = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, roundNum)))
    .orderBy(asc(teeTimesTable.teeTime));

  res.json({ updated: updated.length });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/tee-times/:teeTimeId/players
// Supports actions: 'add', 'remove', 'move' (atomic cross-group player move)
router.patch("/:teeTimeId/players", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimeId = parseInt(String((req.params as Record<string, string>).teeTimeId));
  const { action, playerId, sourceTeeTimeId, swapPlayerId } = req.body;

  if (!action || !playerId) {
    res.status(400).json({ error: "action and playerId are required" });
    return;
  }

  const pid = parseInt(playerId);

  // Validate all player IDs belong to this tournament before any mutation
  const playerIdsToCheck = [pid];
  if (swapPlayerId) playerIdsToCheck.push(parseInt(swapPlayerId));
  const validPlayers = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(inArray(playersTable.id, playerIdsToCheck), eq(playersTable.tournamentId, tournamentId)));
  if (validPlayers.length !== playerIdsToCheck.length) {
    res.status(403).json({ error: "One or more players do not belong to this tournament" });
    return;
  }

  // Verify target tee time belongs to tournament
  const [existing] = await db.select()
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));

  if (!existing) {
    res.status(404).json({ error: "Tee time not found" });
    return;
  }

  // Helper: count current players in a group
  const groupSize = async (ttId: number) =>
    (await db.select({ c: teeTimePlayersTable.playerId }).from(teeTimePlayersTable)
      .where(eq(teeTimePlayersTable.teeTimeId, ttId))).length;

  if (action === 'add') {
    const currentSize = await groupSize(teeTimeId);
    if (currentSize >= 4) {
      res.status(409).json({ error: "Group is full (max 4 players)" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.insert(teeTimePlayersTable).values({ teeTimeId, playerId: pid }).onConflictDoNothing();
      await tx.update(teeTimesTable).set({ isManual: true }).where(eq(teeTimesTable.id, teeTimeId));
    });
  } else if (action === 'remove') {
    await db.delete(teeTimePlayersTable)
      .where(and(eq(teeTimePlayersTable.teeTimeId, teeTimeId), eq(teeTimePlayersTable.playerId, pid)));
  } else if (action === 'move' && sourceTeeTimeId) {
    // Atomic move: remove from source, add to target, mark target as manual
    const srcId = parseInt(sourceTeeTimeId);
    const [srcExists] = await db.select({ id: teeTimesTable.id })
      .from(teeTimesTable)
      .where(and(eq(teeTimesTable.id, srcId), eq(teeTimesTable.tournamentId, tournamentId)));
    if (!srcExists) {
      res.status(404).json({ error: "Source tee time not found" });
      return;
    }
    const currentSize = await groupSize(teeTimeId);
    if (currentSize >= 4) {
      res.status(409).json({ error: "Target group is full (max 4 players)" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(teeTimePlayersTable)
        .where(and(eq(teeTimePlayersTable.teeTimeId, srcId), eq(teeTimePlayersTable.playerId, pid)));
      await tx.insert(teeTimePlayersTable).values({ teeTimeId, playerId: pid }).onConflictDoNothing();
      await tx.update(teeTimesTable).set({ isManual: true }).where(eq(teeTimesTable.id, teeTimeId));
    });
  } else if (action === 'swap' && sourceTeeTimeId && swapPlayerId) {
    // Atomic slot swap: pid (from sourceTeeTimeId) ↔ swapPlayerId (from teeTimeId)
    const srcId = parseInt(sourceTeeTimeId);
    const swapPid = parseInt(swapPlayerId);
    const [srcExists] = await db.select({ id: teeTimesTable.id })
      .from(teeTimesTable)
      .where(and(eq(teeTimesTable.id, srcId), eq(teeTimesTable.tournamentId, tournamentId)));
    if (!srcExists) {
      res.status(404).json({ error: "Source tee time not found" });
      return;
    }
    await db.transaction(async (tx) => {
      // Remove both players from their current groups
      await tx.delete(teeTimePlayersTable)
        .where(and(eq(teeTimePlayersTable.teeTimeId, srcId), eq(teeTimePlayersTable.playerId, pid)));
      await tx.delete(teeTimePlayersTable)
        .where(and(eq(teeTimePlayersTable.teeTimeId, teeTimeId), eq(teeTimePlayersTable.playerId, swapPid)));
      // Cross-insert
      await tx.insert(teeTimePlayersTable).values({ teeTimeId, playerId: pid }).onConflictDoNothing();
      await tx.insert(teeTimePlayersTable).values({ teeTimeId: srcId, playerId: swapPid }).onConflictDoNothing();
      // Mark both groups as manually edited
      await tx.update(teeTimesTable).set({ isManual: true })
        .where(inArray(teeTimesTable.id, [srcId, teeTimeId]));
    });
  } else if (action === 'displace' && swapPlayerId) {
    // Pool→group displacement: remove swapPlayerId from target group, add pid to target group
    // (swapPlayerId is returned to the unassigned pool — no pool table, just removing from tee time)
    const swapPid = parseInt(swapPlayerId);
    await db.transaction(async (tx) => {
      await tx.delete(teeTimePlayersTable)
        .where(and(eq(teeTimePlayersTable.teeTimeId, teeTimeId), eq(teeTimePlayersTable.playerId, swapPid)));
      await tx.insert(teeTimePlayersTable).values({ teeTimeId, playerId: pid }).onConflictDoNothing();
      await tx.update(teeTimesTable).set({ isManual: true }).where(eq(teeTimesTable.id, teeTimeId));
    });
  } else {
    res.status(400).json({ error: "Invalid action. Use 'add', 'remove', 'move', 'swap', or 'displace'" });
    return;
  }

  const [updated] = await db.select().from(teeTimesTable).where(eq(teeTimesTable.id, teeTimeId));
  const players = await db
    .select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex })
    .from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
    .where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));

  res.json({ ...updated, teeTime: updated.teeTime.toISOString(), hole: updated.startingHole, round: updated.round, players });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/tee-times/:teeTimeId
// Supports:
//   - Toggle isManual lock (when no body fields provided)
//   - Update teeTime and/or startingHole (per-group individual assignment)
router.patch("/:teeTimeId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimeId = parseInt(String((req.params as Record<string, string>).teeTimeId));

  const [existing] = await db.select()
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));

  if (!existing) {
    res.status(404).json({ error: "Tee time not found" });
    return;
  }

  const { teeTime, startingHole } = req.body as { teeTime?: string; startingHole?: number };

  const updatePayload: Record<string, unknown> = {};
  if (teeTime !== undefined) updatePayload.teeTime = new Date(teeTime);
  if (startingHole !== undefined) updatePayload.startingHole = startingHole;
  // If no time/hole fields provided, toggle isManual (existing behavior)
  if (Object.keys(updatePayload).length === 0) updatePayload.isManual = !existing.isManual;

  const [updated] = await db.update(teeTimesTable)
    .set(updatePayload)
    .where(eq(teeTimesTable.id, teeTimeId))
    .returning();

  res.json({ ...updated, teeTime: updated.teeTime.toISOString() });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/tee-times/:teeTimeId
router.delete("/:teeTimeId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimeId = parseInt(String((req.params as Record<string, string>).teeTimeId));

  // Verify this tee time belongs to the tournament (ownership check)
  const [existing] = await db.select({ id: teeTimesTable.id })
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));

  if (!existing) {
    res.status(404).json({ error: "Tee time not found" });
    return;
  }

  await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));
  await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeId));
  res.json({ success: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/generate-pairings
router.post("/generate-pairings", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  // Validate request body against schema
  const parsed = GeneratePairingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const {
    round,
    startTime,
    intervalMinutes,
    groupSize,
    startingHole,
    shotgunStart,
    startMode,
    startingHoles,
  } = parsed.data;

  // mode is not part of the Zod schema (it controls player ordering, not start format)
  const mode: string = (req.body as Record<string, unknown>).mode as string ?? 'random';
  // preserveLocked: when false, also delete manually-placed groups before regenerating
  const preserveLocked: boolean = (req.body as Record<string, unknown>).preserveLocked !== false;

  const gSize = groupSize ?? 4;
  const iMinutes = intervalMinutes ?? 10;

  // Resolve effective start mode (new fields take priority, legacy fields as fallback)
  const effectiveStartMode: string = startMode ?? (shotgunStart ? 'shotgun' : 'sequential');

  // Get all players
  const players = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  if (players.length === 0) {
    res.status(400).json({ error: "No players registered" });
    return;
  }

  // Fetch existing tee times for this round; separate locked (manual) from auto-generated
  const existingTimes = await db.select().from(teeTimesTable)
    .where(sql`${teeTimesTable.tournamentId} = ${tournamentId} AND ${teeTimesTable.round} = ${round}`);

  const lockedTimes = preserveLocked ? existingTimes.filter(tt => tt.isManual) : [];
  const timesToDelete = preserveLocked ? existingTimes.filter(tt => !tt.isManual) : existingTimes;

  // Delete auto-generated (or all) tee times depending on preserveLocked
  if (timesToDelete.length > 0) {
    const deleteIds = timesToDelete.map(tt => tt.id);
    await db.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, deleteIds));
    await db.delete(teeTimesTable).where(inArray(teeTimesTable.id, deleteIds));
  }

  // Build set of already-placed player IDs from locked groups
  const lockedPlayerIds = new Set<number>();
  for (const lt of lockedTimes) {
    const ltPlayers = await db.select({ playerId: teeTimePlayersTable.playerId })
      .from(teeTimePlayersTable)
      .where(eq(teeTimePlayersTable.teeTimeId, lt.id));
    for (const lp of ltPlayers) lockedPlayerIds.add(lp.playerId);
  }

  // Order players based on mode — only unplaced players (not already in a locked group)
  const unplacedPlayers = players.filter(p => !lockedPlayerIds.has(p.id));

  let ordered: typeof players;
  const isShotgun = effectiveStartMode === 'shotgun' || mode === 'shotgun';
  const isSplitOrMulti = effectiveStartMode === 'split_tee' || effectiveStartMode === 'multi_hole';
  // Resolve starting holes array for split/multi mode
  const effectiveStartingHoles: number[] = isSplitOrMulti
    ? (Array.isArray(startingHoles) && startingHoles.length >= 2 ? startingHoles : [1, 10])
    : [];

  const results: Array<Record<string, unknown>> = [];

  if (mode === 'handicap') {
    // Sort by handicap ascending (lowest handicap first)
    ordered = [...unplacedPlayers].sort((a, b) => {
      const ah = a.handicapIndex ? parseFloat(String(a.handicapIndex)) : 999;
      const bh = b.handicapIndex ? parseFloat(String(b.handicapIndex)) : 999;
      return ah - bh;
    });
    // Interleave: pair lowest with highest for balanced groups
    const half = Math.ceil(ordered.length / 2);
    const top = ordered.slice(0, half);
    const bottom = ordered.slice(half).reverse();
    const interleaved: typeof players = [];
    for (let i = 0; i < top.length; i++) {
      interleaved.push(top[i]);
      if (bottom[i]) interleaved.push(bottom[i]);
    }
    ordered = interleaved;
  } else if (mode === 'by_flight') {
    // Group within flights first, then shuffle within each flight
    const flightMap: Record<string, typeof players> = {};
    for (const p of unplacedPlayers) {
      const f = p.flight ?? '_none';
      if (!flightMap[f]) flightMap[f] = [];
      flightMap[f].push(p);
    }
    ordered = [];
    for (const f of Object.keys(flightMap).sort()) {
      const shuffledFlight = flightMap[f].sort(() => Math.random() - 0.5);
      ordered.push(...shuffledFlight);
    }
  } else if (mode === 'sequential') {
    // Registration order (already in DB insert order by id)
    ordered = [...unplacedPlayers].sort((a, b) => a.id - b.id);
  } else if (mode === 'abcd') {
    // A/B/C/D scramble draw: balanced bands, one player per band per group.
    // Algorithm:
    //   numGroups = ceil(n/4)
    //   A, B, C bands each have exactly numGroups players (top thirds by handicap)
    //   D band has n - numGroups*3 players = numFoursomes (weakest handicaps)
    //   First numFoursomes groups are foursomes (A+B+C+D); remaining are threesomes (A+B+C).
    //   Result: foursomes appear first, the trailing groups are threesomes.
    const sorted = [...unplacedPlayers].sort((a, b) => {
      const ah = a.handicapIndex ? parseFloat(String(a.handicapIndex)) : 999;
      const bh = b.handicapIndex ? parseFloat(String(b.handicapIndex)) : 999;
      return ah - bh;
    });
    const total = sorted.length;
    if (total === 0) {
      res.json(results);
      return;
    }
    const numGroups = Math.ceil(total / 4);
    const numFoursomes = total - numGroups * 3; // players above minimum threesome fill
    // Build equal-size A, B, C bands (numGroups each); D band has numFoursomes players
    const bandA = sorted.slice(0, numGroups);
    const bandB = sorted.slice(numGroups, numGroups * 2);
    const bandC = sorted.slice(numGroups * 2, numGroups * 3);
    const bandD = sorted.slice(numGroups * 3); // numFoursomes players
    const abcdGroups: typeof players[] = [];
    for (let i = 0; i < numGroups; i++) {
      const grp: typeof players = [bandA[i]];
      if (bandB[i]) grp.push(bandB[i]);
      if (bandC[i]) grp.push(bandC[i]);
      if (bandD[i]) grp.push(bandD[i]); // only present for first numFoursomes groups
      abcdGroups.push(grp);
    }
    // For abcd mode, skip the standard group-building below and create groups directly
    const baseTime = new Date(startTime);
    const intervalMs = iMinutes * 60 * 1000;
    // First add locked times
    for (const lt of lockedTimes) {
      const ltPlayers = await db
        .select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex })
        .from(teeTimePlayersTable)
        .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
        .where(eq(teeTimePlayersTable.teeTimeId, lt.id));
      results.push({ ...lt, teeTime: lt.teeTime.toISOString(), hole: lt.startingHole, round: lt.round, players: ltPlayers });
    }
    for (let i = 0; i < abcdGroups.length; i++) {
      const group = abcdGroups[i];
      const teeTimeDate = isShotgun ? baseTime : new Date(baseTime.getTime() + i * intervalMs);
      const hole = isShotgun ? (i % 18) + 1 : (startingHole ?? 1);
      const [tt] = await db.insert(teeTimesTable)
        .values({ tournamentId, round: round ?? 1, teeTime: teeTimeDate, startingHole: hole })
        .returning();
      await db.insert(teeTimePlayersTable).values(group.map(p => ({ teeTimeId: tt.id, playerId: p.id })));
      results.push({ ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round,
        players: group.map(p => ({ playerId: p.id, firstName: p.firstName, lastName: p.lastName, flight: p.flight ?? null, handicapIndex: p.handicapIndex ?? null })) });
    }
    res.json(results);
    return;
  } else if (mode === 'by_results') {
    // Pairing by previous results: sort by leaderboard position (leaders last)
    const sourceRound: number = (req.body as Record<string, unknown>).sourceRound as number ?? (round > 1 ? round - 1 : 1);
    const tiebreaker: string = (req.body as Record<string, unknown>).tiebreaker as string ?? 'alphabetical';
    // Fetch score totals for sourceRound
    const scoreTotals = await db.select({
      playerId: scoresTable.playerId,
      total: sum(scoresTable.strokes),
    }).from(scoresTable)
      .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.round, sourceRound)))
      .groupBy(scoresTable.playerId);
    const scoreMap = new Map<number, number>();
    for (const row of scoreTotals) {
      if (row.total != null) scoreMap.set(row.playerId, parseInt(String(row.total)));
    }
    // Fetch previous tee time order for tee_time tiebreaker
    const prevTeeTimePlayers: Array<{ playerId: number; teeTime: Date }> = [];
    if (tiebreaker === 'previous_tee_time') {
      const prevTTs = await db.select({ id: teeTimesTable.id, teeTime: teeTimesTable.teeTime })
        .from(teeTimesTable)
        .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, sourceRound)));
      for (const ptt of prevTTs) {
        const pttPlayers = await db.select({ playerId: teeTimePlayersTable.playerId })
          .from(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, ptt.id));
        for (const p of pttPlayers) prevTeeTimePlayers.push({ playerId: p.playerId, teeTime: ptt.teeTime });
      }
    }
    const prevTeeTimeMap = new Map(prevTeeTimePlayers.map(p => [p.playerId, p.teeTime.getTime()]));
    // Sort ascending then reverse: ends up as [unscored(first groups), worst, ..., best/leaders(last groups)]
    // Unscored players placed in early groups (return 1 → they appear last before reversal → first after reversal)
    ordered = [...unplacedPlayers].sort((a, b) => {
      const as = scoreMap.get(a.id);
      const bs = scoreMap.get(b.id);
      if (as == null && bs == null) {
        // Both unscored: apply tiebreaker
        if (tiebreaker === 'alphabetical') return `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`);
        if (tiebreaker === 'random') return Math.random() - 0.5;
        return 0;
      }
      // Unscored: push to end before reversal → they become first groups after reversal
      if (as == null) return 1;
      if (bs == null) return -1;
      if (as !== bs) return as - bs; // lower score (better) first before reversal → last (leaders) after reversal
      // Tie: apply tiebreaker
      if (tiebreaker === 'alphabetical') return `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`);
      if (tiebreaker === 'random') return Math.random() - 0.5;
      if (tiebreaker === 'previous_tee_time') {
        const at = prevTeeTimeMap.get(a.id) ?? 0;
        const bt = prevTeeTimeMap.get(b.id) ?? 0;
        return at - bt;
      }
      return 0;
    });
    // Reverse: result is [unscored(early groups), worst_score, ..., best_score/leaders(last groups)]
    ordered = ordered.reverse();
  } else {
    // random (default)
    ordered = [...unplacedPlayers].sort(() => Math.random() - 0.5);
  }

  // Build groups
  const groups: typeof players[] = [];
  for (let i = 0; i < ordered.length; i += gSize) {
    groups.push(ordered.slice(i, i + gSize));
  }

  const baseTime = new Date(startTime);
  const intervalMs = iMinutes * 60 * 1000;

  // First, add locked times to results (they are preserved as-is)
  for (const lt of lockedTimes) {
    const ltPlayers = await db
      .select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, lt.id));
    results.push({ ...lt, teeTime: lt.teeTime.toISOString(), hole: lt.startingHole, round: lt.round, players: ltPlayers });
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let teeTimeDate: Date;
    let hole: number;

    if (isShotgun) {
      teeTimeDate = baseTime;
      hole = (i % 18) + 1;
    } else if (isSplitOrMulti) {
      // Split-tee / multi-hole: alternate groups between starting holes
      hole = effectiveStartingHoles[i % effectiveStartingHoles.length];
      teeTimeDate = new Date(baseTime.getTime() + Math.floor(i / effectiveStartingHoles.length) * intervalMs);
    } else {
      teeTimeDate = new Date(baseTime.getTime() + i * intervalMs);
      hole = startingHole ?? 1;
    }

    const [tt] = await db
      .insert(teeTimesTable)
      .values({ tournamentId, round: round ?? 1, teeTime: teeTimeDate, startingHole: hole })
      .returning();

    await db.insert(teeTimePlayersTable).values(
      group.map((p) => ({ teeTimeId: tt.id, playerId: p.id })),
    );

    const ttPlayers = group.map((p) => ({
      playerId: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      flight: p.flight ?? null,
      handicapIndex: p.handicapIndex ?? null,
    }));
    results.push({ ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players: ttPlayers });
  }

  res.json(results);
});

// POST /organizations/:orgId/tournaments/:tournamentId/tee-times/copy-round
// Copy all groups and tee times from a source round into a target round
router.post("/copy-round", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { sourceRound, targetRound, swapHoles, reverseTimes } = req.body;
  if (!sourceRound || !targetRound) {
    res.status(400).json({ error: "sourceRound and targetRound are required" });
    return;
  }

  const sourceTimes = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, sourceRound)))
    .orderBy(asc(teeTimesTable.teeTime));

  if (sourceTimes.length === 0) {
    res.status(400).json({ error: `No tee times found for round ${sourceRound}` });
    return;
  }

  // Optionally reverse the time ordering
  const orderedTimes = reverseTimes ? [...sourceTimes].reverse() : sourceTimes;
  const firstSourceTime = sourceTimes[0].teeTime.getTime();

  // Wrap delete + recreate in a transaction for atomicity
  const results = await db.transaction(async (tx) => {
    const existingTarget = await tx.select({ id: teeTimesTable.id }).from(teeTimesTable)
      .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, targetRound)));
    if (existingTarget.length > 0) {
      const ids = existingTarget.map(t => t.id);
      await tx.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, ids));
      await tx.delete(teeTimesTable).where(inArray(teeTimesTable.id, ids));
    }

    const txResults = [];
    for (let i = 0; i < orderedTimes.length; i++) {
      const src = orderedTimes[i];
      const offset = src.teeTime.getTime() - firstSourceTime;
      const newTeeTime = new Date(firstSourceTime + (reverseTimes ? (sourceTimes[sourceTimes.length - 1].teeTime.getTime() - firstSourceTime - offset) : offset));

      let newHole = src.startingHole ?? 1;
      if (swapHoles) {
        if (newHole === 1) newHole = 10;
        else if (newHole === 10) newHole = 1;
      }

      const [tt] = await tx.insert(teeTimesTable)
        .values({ tournamentId, round: targetRound, teeTime: newTeeTime, startingHole: newHole, isManual: false })
        .returning();

      const srcPlayers = await tx.select({ playerId: teeTimePlayersTable.playerId })
        .from(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, src.id));

      if (srcPlayers.length > 0) {
        await tx.insert(teeTimePlayersTable).values(srcPlayers.map(p => ({ teeTimeId: tt.id, playerId: p.playerId })));
      }

      const ttPlayers = await tx.select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex })
        .from(teeTimePlayersTable)
        .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
        .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

      txResults.push({ ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players: ttPlayers });
    }
    return txResults;
  });

  res.json(results);
});

// GET /organizations/:orgId/tournaments/:tournamentId/tee-times/import-pairings/template
// Download a CSV template for importing pairings (supports player_name OR player_id)
router.get("/import-pairings/template", (_req: Request, res: Response) => {
  const csv = [
    'group_number,tee_time,starting_hole,player_name,player_id',
    '1,08:00,1,John Smith,',
    '1,08:00,1,Jane Doe,',
    '2,08:10,1,Bob Johnson,',
    '2,08:10,1,Alice Brown,',
  ].join('\n');
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=pairings-template.csv");
  res.send(csv);
});

// POST /organizations/:orgId/tournaments/:tournamentId/tee-times/import-pairings
// Import pairings from CSV. Accepts JSON body with "csv" text field or raw CSV in body.
// Supports matching by player_name (case-insensitive, "First Last" or "Last First") OR player_id.
router.post("/import-pairings", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { csv, round: roundParam } = req.body as { csv?: string; round?: number };
  const targetRound = roundParam ?? 1;

  if (!csv) {
    res.status(400).json({ error: "csv field is required in request body" });
    return;
  }

  // Parse CSV
  const lines = csv.trim().split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  if (lines.length < 2) {
    res.status(400).json({ error: "CSV must have a header row and at least one data row" });
    return;
  }

  const header = parseCSVLine(lines[0]).map((h: string) => h.toLowerCase());
  const groupCol = header.indexOf('group_number');
  const timeCol = header.indexOf('tee_time');
  const holeCol = header.indexOf('starting_hole');
  const nameCol = header.indexOf('player_name');
  const idCol = header.indexOf('player_id');

  if (groupCol === -1 || (nameCol === -1 && idCol === -1)) {
    res.status(400).json({ error: "CSV must include: group_number, plus player_name and/or player_id. tee_time and starting_hole are optional." });
    return;
  }

  // Load all tournament players for name and id matching
  const allPlayers = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  const playerByName = new Map<string, typeof allPlayers[0]>();
  const playerById = new Map<number, typeof allPlayers[0]>();
  for (const p of allPlayers) {
    playerByName.set(`${p.firstName} ${p.lastName}`.toLowerCase(), p);
    playerByName.set(`${p.lastName} ${p.firstName}`.toLowerCase(), p);
    playerById.set(p.id, p);
  }

  // Parse rows
  type CsvRow = { groupNumber: string; teeTime: string | null; startingHole: number; playerName: string; playerId: number | null };
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 2) continue;
    rows.push({
      groupNumber: cols[groupCol] ?? String(i),
      teeTime: timeCol !== -1 ? cols[timeCol] || null : null,
      startingHole: holeCol !== -1 && cols[holeCol] ? parseInt(cols[holeCol]) || 1 : 1,
      playerName: nameCol !== -1 ? (cols[nameCol] ?? '') : '',
      playerId: idCol !== -1 && cols[idCol] ? parseInt(cols[idCol]) || null : null,
    });
  }

  // Group by group_number
  const groupMap = new Map<string, CsvRow[]>();
  for (const row of rows) {
    if (!groupMap.has(row.groupNumber)) groupMap.set(row.groupNumber, []);
    groupMap.get(row.groupNumber)!.push(row);
  }

  // Validate: find unrecognised player references
  const unrecognised: string[] = [];
  for (const [, grpRows] of groupMap) {
    for (const row of grpRows) {
      // Try player_id first, then player_name
      if (row.playerId != null) {
        if (!playerById.has(row.playerId)) {
          unrecognised.push(`ID:${row.playerId}`);
        }
      } else if (row.playerName) {
        const name = row.playerName.toLowerCase();
        if (!playerByName.has(name)) {
          unrecognised.push(row.playerName);
        }
      }
    }
  }
  if (unrecognised.length > 0) {
    res.status(422).json({ error: "Unrecognised player references", unrecognised });
    return;
  }

  // Wrap delete + recreate in a transaction for atomicity (validation already passed above)
  const baseDate = new Date();
  baseDate.setHours(8, 0, 0, 0);

  const { imported, results } = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: teeTimesTable.id }).from(teeTimesTable)
      .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, targetRound)));
    if (existing.length > 0) {
      const ids = existing.map(t => t.id);
      await tx.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, ids));
      await tx.delete(teeTimesTable).where(inArray(teeTimesTable.id, ids));
    }

    const txResults = [];
    let groupIndex = 0;

    for (const [, grpRows] of groupMap) {
      const firstRow = grpRows[0];
      let teeTimeDate = new Date(baseDate.getTime() + groupIndex * 10 * 60 * 1000);
      if (firstRow.teeTime) {
        if (firstRow.teeTime.includes(':') && !firstRow.teeTime.includes('T')) {
          const [h, m] = firstRow.teeTime.split(':').map(Number);
          const d = new Date(); d.setHours(h, m || 0, 0, 0);
          teeTimeDate = d;
        } else {
          const parsed = new Date(firstRow.teeTime);
          if (!isNaN(parsed.getTime())) teeTimeDate = parsed;
        }
      }
      const hole = firstRow.startingHole;

      const [tt] = await tx.insert(teeTimesTable)
        .values({ tournamentId, round: targetRound, teeTime: teeTimeDate, startingHole: hole, isManual: true })
        .returning();

      const playerIds: number[] = [];
      for (const row of grpRows) {
        let player: typeof allPlayers[0] | undefined;
        if (row.playerId != null) {
          player = playerById.get(row.playerId);
        } else if (row.playerName) {
          player = playerByName.get(row.playerName.toLowerCase());
        }
        if (player) playerIds.push(player.id);
      }

      if (playerIds.length > 0) {
        await tx.insert(teeTimePlayersTable).values(playerIds.map(pid => ({ teeTimeId: tt.id, playerId: pid })));
      }

      const ttPlayers = await tx.select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, flight: playersTable.flight, handicapIndex: playersTable.handicapIndex })
        .from(teeTimePlayersTable)
        .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
        .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

      txResults.push({ ...tt, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players: ttPlayers });
      groupIndex++;
    }
    return { imported: txResults.length, results: txResults };
  });

  res.json({ imported, results });
});

// POST /organizations/:orgId/tournaments/:tournamentId/publish-pairings
router.post("/publish-pairings", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const [tournament] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    notifyPairings: tournamentsTable.notifyPairings,
    pairingsPublishedAt: tournamentsTable.pairingsPublishedAt,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Idempotency guard — already published
  if (tournament.pairingsPublishedAt) {
    res.json({ notified: 0, alreadyPublished: true, publishedAt: tournament.pairingsPublishedAt });
    return;
  }

  // Get all tee times with players
  const teeTimes = await db.select({ id: teeTimesTable.id, teeTime: teeTimesTable.teeTime, startingHole: teeTimesTable.startingHole })
    .from(teeTimesTable).where(eq(teeTimesTable.tournamentId, tournamentId));

  if (teeTimes.length === 0) {
    res.status(400).json({ error: "No pairings found. Generate pairings first." });
    return;
  }

  // Build per-player tee time map (playerId → { teeTime, hole, partners })
  const playerTeeTimeMap = new Map<number, { teeTime: Date; hole: number; partners: string[] }>();
  for (const tt of teeTimes) {
    const ttPlayers = await db.select({ playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(teeTimePlayersTable).innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));
    for (const p of ttPlayers) {
      const partners = ttPlayers.filter(q => q.playerId !== p.playerId).map(q => `${q.firstName} ${q.lastName}`);
      playerTeeTimeMap.set(p.playerId, { teeTime: tt.teeTime, hole: tt.startingHole ?? 1, partners });
    }
  }

  // Get player userId + email
  const playerIds = [...playerTeeTimeMap.keys()];
  const playerRows = await db.select({ id: playersTable.id, userId: playersTable.userId, email: playersTable.email, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable).where(inArray(playersTable.id, playerIds));

  // Fetch emails from appUsersTable if needed
  const userIds = playerRows.map(p => p.userId).filter((id): id is number => id != null && id > 0);

  let notified = 0;

  // Send push notifications
  if (tournament.notifyPairings) {
    const pushUserIds = userIds;
    if (pushUserIds.length > 0) {
      const pushPromises = playerRows
        .filter(p => p.userId != null)
        .map(p => {
          const slot = playerTeeTimeMap.get(p.id);
          if (!slot) return Promise.resolve();
          const timeStr = slot.teeTime.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
          const partnersStr = slot.partners.length > 0 ? ` with ${slot.partners.slice(0, 2).join(" & ")}` : "";
          // Task #1240 — fire-and-forget per-recipient push; the
          // PushDeliveryResult is discarded (`.catch(() => undefined)`),
          // so no `classifyPushDelivery` mapping is needed. Email below
          // is the durable channel for players without an Expo token.
          return sendTransactionalPush(
            [p.userId!],
            `⛳ Tee Times Published — ${tournament.name}`,
            `You tee off at ${timeStr} from Hole ${slot.hole}${partnersStr}.`,
            { type: "pairings_published", tournamentId },
          ).catch(() => undefined);
        });
      await Promise.all(pushPromises);
      notified += pushUserIds.length;
    }

    // Send emails
    const emailRows = playerRows.filter(p => p.email);
    for (const p of emailRows) {
      const slot = playerTeeTimeMap.get(p.id);
      if (!slot) continue;
      sendPairingsEmail({
        to: p.email!,
        name: `${p.firstName} ${p.lastName}`,
        tournamentName: tournament.name,
        teeTime: slot.teeTime,
        startingHole: slot.hole,
        partners: slot.partners,
      }).catch(() => undefined);
    }
  }

  // Mark pairings as published
  await db.update(tournamentsTable).set({ pairingsPublishedAt: new Date() }).where(eq(tournamentsTable.id, tournamentId));

  // Task #2008 — branded `tournament.tee.published` central dispatch (push +
  // branded email + digest fan-out per recipient preference). The bespoke
  // sendTransactionalPush + sendPairingsEmail loops above stay in place
  // because they carry richer per-player tee time / partners detail.
  if (tournament.notifyPairings && userIds.length > 0) {
    void notifyTournamentTeePublished({
      userIds: Array.from(new Set(userIds)),
      tournamentId,
      tournamentName: tournament.name,
    });
  }

  res.json({ notified, publishedAt: new Date().toISOString() });
});

export default router;
