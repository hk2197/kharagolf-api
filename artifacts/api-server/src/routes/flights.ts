import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { flightsTable, playerFlightsTable, playersTable } from "@workspace/db";
import { eq, sql, and, inArray } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/tournaments/:tournamentId/flights/handicap-distribution
// Must be declared BEFORE /:flightId routes to avoid param collision
router.get("/handicap-distribution", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const players = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      handicapOverride: playersTable.handicapOverride,
    })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  // Build bucketed histogram (integer buckets)
  const bucketMap = new Map<number, number>();
  for (const p of players) {
    const hcp = p.handicapOverride != null
      ? parseFloat(String(p.handicapOverride))
      : p.handicapIndex != null
        ? parseFloat(String(p.handicapIndex))
        : null;
    if (hcp == null) continue;
    const bucket = Math.floor(hcp);
    bucketMap.set(bucket, (bucketMap.get(bucket) ?? 0) + 1);
  }

  const buckets = Array.from(bucketMap.entries())
    .map(([hcp, count]) => ({ hcp, count }))
    .sort((a, b) => a.hcp - b.hcp);

  res.json({
    players: players.map(p => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      handicapIndex: p.handicapOverride != null ? String(p.handicapOverride) : p.handicapIndex != null ? String(p.handicapIndex) : null,
    })),
    buckets,
  });
});

// GET /organizations/:orgId/tournaments/:tournamentId/flights
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const flights = await db
    .select()
    .from(flightsTable)
    .where(eq(flightsTable.tournamentId, tournamentId))
    .orderBy(flightsTable.createdAt);

  const flightsWithPlayers = await Promise.all(
    flights.map(async (flight) => {
      const players = await db
        .select({
          playerId: playerFlightsTable.playerId,
          firstName: playersTable.firstName,
          lastName: playersTable.lastName,
          handicapIndex: playersTable.handicapIndex,
          checkedIn: playersTable.checkedIn,
        })
        .from(playerFlightsTable)
        .innerJoin(playersTable, eq(playerFlightsTable.playerId, playersTable.id))
        .where(eq(playerFlightsTable.flightId, flight.id));
      return { ...flight, players };
    }),
  );

  res.json(flightsWithPlayers);
});

// POST /organizations/:orgId/tournaments/:tournamentId/flights
router.post("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { name, description, handicapMin, handicapMax, teeBox, maxPlayers, tiebreakerMethod } = req.body;

  if (!name) {
    res.status(400).json({ error: "Flight name is required" });
    return;
  }

  const [flight] = await db
    .insert(flightsTable)
    .values({
      tournamentId,
      name,
      description: description ?? null,
      handicapMin: handicapMin != null ? String(handicapMin) : null,
      handicapMax: handicapMax != null ? String(handicapMax) : null,
      teeBox: teeBox ?? null,
      maxPlayers: maxPlayers ?? null,
      tiebreakerMethod: tiebreakerMethod ?? null,
    })
    .returning();

  res.status(201).json({ ...flight, players: [] });
});

// POST /organizations/:orgId/tournaments/:tournamentId/flights/auto-assign
// Must be declared BEFORE /:flightId routes to avoid param collision
router.post("/auto-assign", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { flightId: filterFlightId } = req.body as { flightId?: number };

  // Get all flights for this tournament (with handicap ranges), optionally filtered to one flight
  const allFlights = await db
    .select()
    .from(flightsTable)
    .where(eq(flightsTable.tournamentId, tournamentId));

  const flightsToProcess = allFlights
    .filter(f =>
      f.handicapMin != null && f.handicapMax != null &&
      (filterFlightId == null || f.id === filterFlightId)
    )
    // Sort by handicapMin ascending, then createdAt for deterministic processing order
    .sort((a, b) => {
      const minDiff = parseFloat(a.handicapMin!) - parseFloat(b.handicapMin!);
      if (minDiff !== 0) return minDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  if (flightsToProcess.length === 0) {
    res.json({ results: [], message: "No flights with handicap ranges found" });
    return;
  }

  // Get all players in this tournament
  const allPlayers = await db
    .select({
      id: playersTable.id,
      handicapIndex: playersTable.handicapIndex,
      handicapOverride: playersTable.handicapOverride,
    })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  // Get all existing player-flight assignments for this tournament's flights
  const flightIds = allFlights.map(f => f.id);
  const existingAssignments = flightIds.length > 0
    ? await db
        .select({ playerId: playerFlightsTable.playerId, flightId: playerFlightsTable.flightId })
        .from(playerFlightsTable)
        .where(inArray(playerFlightsTable.flightId, flightIds))
    : [];

  const results: { flightId: number; flightName: string; assigned: number; skipped: number }[] = [];

  for (const flight of flightsToProcess) {
    const hcpMin = parseFloat(flight.handicapMin!);
    const hcpMax = parseFloat(flight.handicapMax!);

    // Players already assigned to THIS specific flight
    const alreadyInThisFlight = new Set(
      existingAssignments
        .filter(a => a.flightId === flight.id)
        .map(a => a.playerId)
    );

    // Players already in ANY flight (unflighted = not in any flight at all)
    const assignedToAnyFlight = new Set(existingAssignments.map(a => a.playerId));

    // Find unflighted players whose handicap falls in range
    const candidates = allPlayers.filter(p => {
      if (assignedToAnyFlight.has(p.id)) return false;
      const hcp = p.handicapOverride != null ? parseFloat(String(p.handicapOverride)) :
                  p.handicapIndex != null ? parseFloat(String(p.handicapIndex)) : null;
      if (hcp == null) return false;
      return hcp >= hcpMin && hcp <= hcpMax;
    });

    // Respect maxPlayers cap
    const currentCount = alreadyInThisFlight.size;
    const cap = flight.maxPlayers;
    const available = cap != null ? Math.max(0, cap - currentCount) : candidates.length;
    const toAssign = candidates.slice(0, available);

    let assigned = 0;
    let skipped = 0;

    for (const player of toAssign) {
      const inserted = await db
        .insert(playerFlightsTable)
        .values({ playerId: player.id, flightId: flight.id })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        // Track newly assigned so subsequent flights don't double-assign
        existingAssignments.push({ playerId: player.id, flightId: flight.id });
        assigned++;
      } else {
        skipped++;
      }
    }

    results.push({ flightId: flight.id, flightName: flight.name, assigned, skipped });
  }

  res.json({ results });
});

// PUT /organizations/:orgId/tournaments/:tournamentId/flights/:flightId
router.put("/:flightId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  const body = req.body as Record<string, unknown>;

  // Build a partial update — only include fields explicitly present in the request body
  const patch: Record<string, unknown> = {};
  if ("name" in body) patch.name = body.name;
  if ("description" in body) patch.description = body.description ?? null;
  if ("handicapMin" in body) patch.handicapMin = body.handicapMin != null ? String(body.handicapMin) : null;
  if ("handicapMax" in body) patch.handicapMax = body.handicapMax != null ? String(body.handicapMax) : null;
  if ("teeBox" in body) patch.teeBox = body.teeBox ?? null;
  if ("maxPlayers" in body) patch.maxPlayers = body.maxPlayers ?? null;
  if ("tiebreakerMethod" in body) patch.tiebreakerMethod = body.tiebreakerMethod ?? null;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields provided to update" });
    return;
  }

  const [flight] = await db
    .update(flightsTable)
    .set(patch as Partial<typeof flightsTable.$inferInsert>)
    .where(sql`${flightsTable.id} = ${flightId} AND ${flightsTable.tournamentId} = ${tournamentId}`)
    .returning();

  if (!flight) { { res.status(404).json({ error: "Flight not found" }); return; } }
  res.json(flight);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/flights/:flightId
router.delete("/:flightId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));

  await db
    .delete(flightsTable)
    .where(sql`${flightsTable.id} = ${flightId} AND ${flightsTable.tournamentId} = ${tournamentId}`);

  res.status(204).send();
});

// POST /organizations/:orgId/tournaments/:tournamentId/flights/:flightId/players — assign player to flight
router.post("/:flightId/players", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  const { playerId } = req.body;

  if (!playerId) { { res.status(400).json({ error: "playerId is required" }); return; } }

  // Check flight belongs to this tournament
  const [flight] = await db
    .select()
    .from(flightsTable)
    .where(sql`${flightsTable.id} = ${flightId} AND ${flightsTable.tournamentId} = ${tournamentId}`);

  if (!flight) { { res.status(404).json({ error: "Flight not found" }); return; } }

  // Validate player belongs to this tournament (prevents cross-tournament IDOR)
  const [player] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) { { res.status(400).json({ error: "Player not found in this tournament" }); return; } }

  const [existing] = await db
    .select()
    .from(playerFlightsTable)
    .where(sql`${playerFlightsTable.playerId} = ${playerId} AND ${playerFlightsTable.flightId} = ${flightId}`);

  if (existing) {
    res.status(409).json({ error: "Player already in this flight" });
    return;
  }

  // Enforce maxPlayers cap if set
  if (flight.maxPlayers != null) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(playerFlightsTable)
      .where(eq(playerFlightsTable.flightId, flightId));
    if (count >= flight.maxPlayers) {
      res.status(409).json({ error: `Flight is at capacity (${flight.maxPlayers} players)` });
      return;
    }
  }

  const [row] = await db
    .insert(playerFlightsTable)
    .values({ playerId, flightId })
    .returning();

  res.status(201).json(row);
});

// POST /organizations/:orgId/tournaments/:tournamentId/flights/:flightId/players/bulk — batch assign
router.post("/:flightId/players/bulk", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  const { playerIds: rawPlayerIds } = req.body as { playerIds?: number[] };

  if (!Array.isArray(rawPlayerIds) || rawPlayerIds.length === 0) {
    res.status(400).json({ error: "playerIds array is required and must not be empty" });
    return;
  }

  // De-duplicate input IDs
  const playerIds = [...new Set(rawPlayerIds)];

  type BulkResult = { assigned: number; skipped: number } | { error: string; status: number };

  let result: BulkResult;

  try {
    result = await db.transaction(async (tx) => {
      // Check flight exists and belongs to this tournament (prevents IDOR cross-tournament assignment)
      const [flight] = await tx
        .select()
        .from(flightsTable)
        .where(sql`${flightsTable.id} = ${flightId} AND ${flightsTable.tournamentId} = ${tournamentId}`);

      if (!flight) {
        return { error: "Flight not found", status: 404 };
      }

      // Validate all playerIds belong to this tournament (prevents cross-tournament IDOR)
      const validPlayers = await tx
        .select({ id: playersTable.id })
        .from(playersTable)
        .where(
          and(
            eq(playersTable.tournamentId, tournamentId),
            inArray(playersTable.id, playerIds)
          )
        );
      const validPlayerIds = new Set(validPlayers.map(p => p.id));
      const invalidIds = playerIds.filter(pid => !validPlayerIds.has(pid));
      if (invalidIds.length > 0) {
        return { error: `Player IDs not found in this tournament: ${invalidIds.join(", ")}`, status: 400 };
      }

      // Enforce maxPlayers cap inside transaction to prevent concurrent over-subscription.
      // Capacity check must account for idempotency: players already in this flight are skipped
      // by onConflictDoNothing and do not consume an additional slot.
      if (flight.maxPlayers != null) {
        // Count players currently in this flight who are NOT in the incoming payload
        // (i.e., existing occupants who aren't already being re-submitted)
        const alreadyInFlight = await tx
          .select({ playerId: playerFlightsTable.playerId })
          .from(playerFlightsTable)
          .where(eq(playerFlightsTable.flightId, flightId));
        const alreadyInFlightSet = new Set(alreadyInFlight.map(r => r.playerId));

        // New (net-new) players that would actually consume slots
        const netNewCount = playerIds.filter(pid => !alreadyInFlightSet.has(pid)).length;
        const currentCount = alreadyInFlight.length;
        const remaining = flight.maxPlayers - currentCount;

        if (netNewCount > remaining) {
          return { error: `Only ${remaining} spot${remaining !== 1 ? "s" : ""} remain in this flight`, status: 409 };
        }
      }

      // Insert all in one go; already-assigned pairs are silently skipped (idempotent)
      const rows = playerIds.map(pid => ({ playerId: pid, flightId }));
      const inserted = await tx
        .insert(playerFlightsTable)
        .values(rows)
        .onConflictDoNothing()
        .returning();

      return { assigned: inserted.length, skipped: playerIds.length - inserted.length };
    });
  } catch {
    res.status(500).json({ error: "Internal server error during bulk assign" });
    return;
  }

  if ("error" in result) {
    res.status(result.status).json({ error: result.error });
  } else {
    res.status(201).json(result);
  }
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/flights/:flightId/players/:playerId — remove player from flight
router.delete("/:flightId/players/:playerId", async (req: Request, res: Response) => {
  const flightId = parseInt(String((req.params as Record<string, string>).flightId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  await db
    .delete(playerFlightsTable)
    .where(sql`${playerFlightsTable.playerId} = ${playerId} AND ${playerFlightsTable.flightId} = ${flightId}`);

  res.status(204).send();
});

export default router;
