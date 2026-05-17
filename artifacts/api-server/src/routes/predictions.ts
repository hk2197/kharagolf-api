/**
 * Task #378 — Pre-tournament prediction games (read-only / fun-only).
 * Mounted under /organizations/:orgId/tournaments/:tournamentId/predictions.
 *
 * NO monetary stakes, NO entry fees, NO prizes of monetary value. This is a
 * free-to-play prediction game for fans. Submissions lock at tournament start.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { tournamentsTable, tournamentPredictionsTable, playersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

function getCallerUserId(req: Request): number | null {
  const u = req.user as { id?: number } | undefined;
  return u?.id ?? null;
}

async function loadTournamentForPredictions(orgId: number, tournamentId: number) {
  const [t] = await db
    .select({
      id: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      status: tournamentsTable.status,
      predictionsEnabled: tournamentsTable.predictionsEnabled,
    })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  return t ?? null;
}

function isLocked(t: { startDate: Date | null; status: string }): boolean {
  if (t.status === "active" || t.status === "completed") return true;
  if (t.startDate && t.startDate.getTime() <= Date.now()) return true;
  return false;
}

// GET — current user's prediction (or null)
router.get("/me", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  const userId = getCallerUserId(req);
  if (!userId) { res.status(401).json({ error: "unauthorized" }); return; }

  const t = await loadTournamentForPredictions(orgId, tournamentId);
  if (!t) { res.status(404).json({ error: "not_found" }); return; }
  if (!t.predictionsEnabled) { res.status(403).json({ error: "predictions_disabled" }); return; }

  const [row] = await db
    .select()
    .from(tournamentPredictionsTable)
    .where(and(
      eq(tournamentPredictionsTable.tournamentId, tournamentId),
      eq(tournamentPredictionsTable.userId, userId),
    ));

  res.json({
    prediction: row ?? null,
    locked: isLocked(t),
    lockAt: t.startDate,
  });
});

// POST — submit or update (idempotent until lock)
router.post("/", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  const userId = getCallerUserId(req);
  if (!userId) { res.status(401).json({ error: "unauthorized" }); return; }

  const t = await loadTournamentForPredictions(orgId, tournamentId);
  if (!t) { res.status(404).json({ error: "not_found" }); return; }
  if (!t.predictionsEnabled) { res.status(403).json({ error: "predictions_disabled" }); return; }
  if (isLocked(t)) { res.status(409).json({ error: "locked", message: "Predictions are locked." }); return; }

  const { predictedWinnerPlayerId, predictedTop5, predictedLowRound, displayName } = req.body ?? {};

  const winnerId = predictedWinnerPlayerId == null ? null : Number(predictedWinnerPlayerId);
  const top5 = Array.isArray(predictedTop5) ? predictedTop5.map(Number).filter(Number.isFinite).slice(0, 5) : [];
  const lowRound = predictedLowRound == null ? null : Number(predictedLowRound);

  // Validate player IDs belong to this tournament
  const allPlayerIds = new Set([winnerId, ...top5].filter((x): x is number => x != null));
  if (allPlayerIds.size > 0) {
    const valid = await db.select({ id: playersTable.id })
      .from(playersTable).where(eq(playersTable.tournamentId, tournamentId));
    const validSet = new Set(valid.map(v => v.id));
    for (const pid of allPlayerIds) {
      if (!validSet.has(pid)) { res.status(400).json({ error: "invalid_player", playerId: pid }); return; }
    }
  }

  try {
    const [existing] = await db
      .select()
      .from(tournamentPredictionsTable)
      .where(and(
        eq(tournamentPredictionsTable.tournamentId, tournamentId),
        eq(tournamentPredictionsTable.userId, userId),
      ));

    if (existing) {
      const [updated] = await db
        .update(tournamentPredictionsTable)
        .set({
          predictedWinnerPlayerId: winnerId,
          predictedTop5: top5,
          predictedLowRound: lowRound,
          displayName: displayName ? String(displayName).slice(0, 64) : existing.displayName,
        })
        .where(eq(tournamentPredictionsTable.id, existing.id))
        .returning();
      res.json({ prediction: updated, locked: false }); return;
    }

    const [created] = await db
      .insert(tournamentPredictionsTable)
      .values({
        tournamentId,
        userId,
        predictedWinnerPlayerId: winnerId,
        predictedTop5: top5,
        predictedLowRound: lowRound,
        displayName: displayName ? String(displayName).slice(0, 64) : null,
      })
      .returning();
    res.status(201).json({ prediction: created, locked: false }); return;
  } catch (err) {
    logger.error({ err }, "predictions submit failed");
    res.status(500).json({ error: "submit_failed" });
  }
});

export default router;
