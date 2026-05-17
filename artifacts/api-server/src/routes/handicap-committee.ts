/**
 * Handicap Committee Tools API
 * Scoped to: /organizations/:orgId/handicap
 *
 * GET    /exceptional-scores                          ESR queue (auto-flagged by WHS posting flow)
 * POST   /exceptional-scores                          Manually create an ESR flag for a player round
 * DELETE /exceptional-scores/:flagId                 Remove/unflag an ESR flag (committee-only)
 * POST   /exceptional-scores/:flagId/apply           Apply committee adjustment (upward-only, mandatory reason)
 * POST   /exceptional-scores/:flagId/dismiss         Dismiss ESR flag with mandatory notes
 * POST   /adjustments                                Manual upward committee adjustment (mandatory reason)
 * GET    /adjustments                                List adjustments (optional ?from=&to= date range)
 * GET    /adjustments/export.csv                     Period export of all adjustments as CSV
 * GET    /stats                                      Committee overview stats
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  playersTable,
  tournamentsTable,
  exceptionalScoreFlagsTable,
  handicapAdjustmentsTable,
  appUsersTable,
  whsPostingsTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, sql, avg, min, max, count, gte, lte } from "drizzle-orm";
import { requireCommitteeMember } from "../lib/permissions";
import {
  notifyHandicapCommitteeChanged,
  notifyHandicapExceptionalScore,
} from "../lib/brandedNotifications";

const router: IRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────── */

/** Verify player belongs to this org (via their tournament). */
async function verifyPlayerOrg(playerId: number, orgId: number): Promise<boolean> {
  const [row] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(and(eq(playersTable.id, playerId), eq(tournamentsTable.organizationId, orgId)));
  return !!row;
}

/** Effective handicap index for a player (override takes precedence). */
function effectiveHcp(player: { handicapIndex: string | null; handicapOverride: string | null }): number | null {
  if (player.handicapOverride != null) return Number(player.handicapOverride);
  if (player.handicapIndex != null) return Number(player.handicapIndex);
  return null;
}

/* ─── GET /exceptional-scores — ESR Queue ────────────────────────── */

router.get("/exceptional-scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const statusFilter = typeof req.query.status === "string" ? req.query.status : "pending";

  const rows = await db
    .select({
      id: exceptionalScoreFlagsTable.id,
      playerId: exceptionalScoreFlagsTable.playerId,
      tournamentId: exceptionalScoreFlagsTable.tournamentId,
      round: exceptionalScoreFlagsTable.round,
      scoreDifferential: exceptionalScoreFlagsTable.scoreDifferential,
      previousHandicapIndex: exceptionalScoreFlagsTable.previousHandicapIndex,
      projectedHandicapIndex: exceptionalScoreFlagsTable.projectedHandicapIndex,
      adjustedHandicapIndex: exceptionalScoreFlagsTable.adjustedHandicapIndex,
      status: exceptionalScoreFlagsTable.status,
      notes: exceptionalScoreFlagsTable.notes,
      flaggedAt: exceptionalScoreFlagsTable.flaggedAt,
      reviewedAt: exceptionalScoreFlagsTable.reviewedAt,
      postingId: exceptionalScoreFlagsTable.postingId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      tournamentName: tournamentsTable.name,
      tournamentStartDate: tournamentsTable.startDate,
      reviewerName: appUsersTable.displayName,
      // WHS posting context — round score data
      grossScore: whsPostingsTable.grossScore,
      adjustedGrossScore: whsPostingsTable.adjustedGrossScore,
      postingCourseRating: whsPostingsTable.courseRating,
      postingSlope: whsPostingsTable.slope,
      postedAt: whsPostingsTable.postedAt,
    })
    .from(exceptionalScoreFlagsTable)
    .innerJoin(playersTable, eq(exceptionalScoreFlagsTable.playerId, playersTable.id))
    .leftJoin(tournamentsTable, eq(exceptionalScoreFlagsTable.tournamentId, tournamentsTable.id))
    .leftJoin(appUsersTable, eq(exceptionalScoreFlagsTable.reviewedByUserId, appUsersTable.id))
    .leftJoin(whsPostingsTable, eq(exceptionalScoreFlagsTable.postingId, whsPostingsTable.id))
    .where(
      statusFilter === "all"
        ? eq(exceptionalScoreFlagsTable.organizationId, orgId)
        : and(eq(exceptionalScoreFlagsTable.organizationId, orgId), eq(exceptionalScoreFlagsTable.status, statusFilter))
    )
    .orderBy(desc(exceptionalScoreFlagsTable.flaggedAt));

  res.json(rows.map(r => ({
    ...r,
    scoreDifferential: Number(r.scoreDifferential),
    previousHandicapIndex: r.previousHandicapIndex ? Number(r.previousHandicapIndex) : null,
    projectedHandicapIndex: r.projectedHandicapIndex ? Number(r.projectedHandicapIndex) : null,
    adjustedHandicapIndex: r.adjustedHandicapIndex ? Number(r.adjustedHandicapIndex) : null,
    postingCourseRating: r.postingCourseRating ? Number(r.postingCourseRating) : null,
    flaggedAt: r.flaggedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    postedAt: r.postedAt?.toISOString() ?? null,
  })));
});

/* ─── POST /exceptional-scores — Manual ESR flag creation ───────── */

router.post("/exceptional-scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { playerId, tournamentId, round, scoreDifferential, notes, postingId } = req.body as {
    playerId: number;
    tournamentId?: number;
    round?: number;
    scoreDifferential: number;
    notes?: string;
    postingId?: number;
  };

  if (!playerId || !scoreDifferential) {
    res.status(400).json({ error: "playerId and scoreDifferential are required" });
    return;
  }

  // Verify player belongs to this org
  const [playerRow] = await db.select({ handicapIndex: playersTable.handicapIndex, handicapOverride: playersTable.handicapOverride })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(and(eq(playersTable.id, playerId), eq(tournamentsTable.organizationId, orgId)));

  if (!playerRow) { { res.status(404).json({ error: "Player not found in this organization" }); return; } }

  // If postingId supplied, verify it belongs to this player and org before linking
  let resolvedPostingId: number | null = postingId ?? null;
  if (resolvedPostingId) {
    const [posting] = await db
      .select({ id: whsPostingsTable.id })
      .from(whsPostingsTable)
      .innerJoin(tournamentsTable, eq(whsPostingsTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(whsPostingsTable.id, resolvedPostingId),
        eq(whsPostingsTable.playerId, playerId),
        eq(tournamentsTable.organizationId, orgId),
      ));
    if (!posting) resolvedPostingId = null; // posting not found/unauthorized — don't link
  }

  const prevHcp = effectiveHcp(playerRow);

  const [flag] = await db.insert(exceptionalScoreFlagsTable).values({
    organizationId: orgId,
    playerId,
    tournamentId: tournamentId ?? null,
    round: round ?? null,
    scoreDifferential: String(scoreDifferential),
    previousHandicapIndex: prevHcp != null ? String(prevHcp) : null,
    status: "pending",
    notes: notes ?? "Manually flagged by committee",
    flaggedAt: new Date(),
    postingId: resolvedPostingId ?? undefined,
  }).returning();

  res.status(201).json({
    ...flag,
    scoreDifferential: Number(flag.scoreDifferential),
    previousHandicapIndex: flag.previousHandicapIndex ? Number(flag.previousHandicapIndex) : null,
    projectedHandicapIndex: null,
    adjustedHandicapIndex: null,
    flaggedAt: flag.flaggedAt.toISOString(),
    reviewedAt: null,
  });
});

/* ─── DELETE /exceptional-scores/:flagId — Unflag / remove ESR ───── */

router.delete("/exceptional-scores/:flagId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const flagId = parseInt(String((req.params as Record<string, string>).flagId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const [flag] = await db.select().from(exceptionalScoreFlagsTable)
    .where(and(eq(exceptionalScoreFlagsTable.id, flagId), eq(exceptionalScoreFlagsTable.organizationId, orgId)));

  if (!flag) { { res.status(404).json({ error: "Flag not found" }); return; } }
  if (flag.status === "applied") { { res.status(400).json({ error: "Cannot remove a flag with an applied adjustment. Use dismiss instead." }); return; } }

  await db.delete(exceptionalScoreFlagsTable)
    .where(and(eq(exceptionalScoreFlagsTable.id, flagId), eq(exceptionalScoreFlagsTable.organizationId, orgId)));

  res.json({ success: true, message: "ESR flag removed" });
});

/* ─── POST /exceptional-scores/:flagId/apply — Apply ESR adjustment ─ */

router.post("/exceptional-scores/:flagId/apply", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const flagId = parseInt(String((req.params as Record<string, string>).flagId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  // Accept upward adjustment strokes + mandatory reason (spec: entered as strokes, not absolute HI)
  const { adjustmentStrokes, reason, notes } = req.body as {
    adjustmentStrokes: number;
    reason: string;
    notes?: string;
  };

  if (typeof adjustmentStrokes !== "number" || isNaN(adjustmentStrokes)) {
    res.status(400).json({ error: "adjustmentStrokes must be a number (upward strokes to add to current HI)" });
    return;
  }
  if (adjustmentStrokes <= 0) {
    res.status(400).json({ error: "adjustmentStrokes must be positive (committee adjustments are upward-only)" });
    return;
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    res.status(400).json({ error: "reason is required for every committee adjustment" });
    return;
  }

  const [flag] = await db.select().from(exceptionalScoreFlagsTable)
    .where(and(eq(exceptionalScoreFlagsTable.id, flagId), eq(exceptionalScoreFlagsTable.organizationId, orgId)));
  if (!flag) { { res.status(404).json({ error: "ESR flag not found" }); return; } }
  if (flag.status !== "pending") { { res.status(400).json({ error: `Flag already ${flag.status}` }); return; } }

  const [player] = await db.select().from(playersTable).where(eq(playersTable.id, flag.playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  const current = effectiveHcp(player);
  // Compute resulting HI: current + adjustment strokes, capped at 54.0
  const resultingHI = Math.min(54.0, (current ?? 0) + adjustmentStrokes);

  await db.update(exceptionalScoreFlagsTable).set({
    status: "applied",
    adjustedHandicapIndex: String(resultingHI),
    reviewedByUserId: req.user?.id ?? null,
    reviewedAt: new Date(),
    notes: notes ?? null,
  }).where(eq(exceptionalScoreFlagsTable.id, flagId));

  // Record the committee adjustment audit entry — do NOT auto-update handicapOverride.
  // Actual HI update is performed manually by the committee in player profile (per task spec).
  const [adj] = await db.insert(handicapAdjustmentsTable).values({
    organizationId: orgId,
    playerId: flag.playerId,
    adjustedByUserId: req.user?.id ?? null,
    previousHandicapIndex: current != null ? String(current) : null,
    newHandicapIndex: String(resultingHI),
    adjustmentStrokes: String(adjustmentStrokes),
    adjustmentReason: reason.trim(),
    committeeNotes: notes ?? null,
    tournamentId: flag.tournamentId ?? null,
    flagId: flagId, // ESR flag → adjustment traceability
  }).returning();

  // Task #2008 — branded `handicap.exceptional.score` dispatch to the player
  // whose HI was reduced. Wrapped in fire-and-forget so the audit insert
  // above stays the source of truth even if the notify path errors.
  if (player.userId) {
    void notifyHandicapExceptionalScore({
      userIds: [player.userId],
      oldIndex: current ?? undefined,
      newIndex: resultingHI,
      reduction: adjustmentStrokes,
      reason: reason.trim(),
    });
  }

  res.json({
    success: true,
    adjustmentId: adj.id,
    adjustmentStrokes,
    previousHandicapIndex: current,
    resultingHandicapIndex: resultingHI,
    note: "Handicap index update not applied automatically. Committee member should update player HI manually.",
  });
});

/* ─── POST /exceptional-scores/:flagId/dismiss — Dismiss ESR ─────── */

router.post("/exceptional-scores/:flagId/dismiss", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const flagId = parseInt(String((req.params as Record<string, string>).flagId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { notes } = req.body as { notes?: string };
  if (!notes || typeof notes !== "string" || notes.trim().length === 0) {
    res.status(400).json({ error: "notes are required when dismissing an ESR flag" });
    return;
  }

  const [flag] = await db.select().from(exceptionalScoreFlagsTable)
    .where(and(eq(exceptionalScoreFlagsTable.id, flagId), eq(exceptionalScoreFlagsTable.organizationId, orgId)));
  if (!flag) { { res.status(404).json({ error: "ESR flag not found" }); return; } }
  if (flag.status !== "pending") { { res.status(400).json({ error: `Flag already ${flag.status}` }); return; } }

  await db.update(exceptionalScoreFlagsTable).set({
    status: "dismissed",
    reviewedByUserId: req.user?.id ?? null,
    reviewedAt: new Date(),
    notes: notes.trim(),
  }).where(eq(exceptionalScoreFlagsTable.id, flagId));

  res.json({ success: true });
});

/* ─── POST /adjustments — Manual Upward Committee Adjustment ─────── */

router.post("/adjustments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  // Accept upward adjustment strokes + mandatory reason (spec: entered as strokes, not absolute HI)
  const { playerId, adjustmentStrokes, adjustmentReason, committeeNotes, tournamentId } = req.body as {
    playerId: number;
    adjustmentStrokes: number;
    adjustmentReason: string;
    committeeNotes?: string;
    tournamentId?: number;
  };

  if (typeof playerId !== "number") { { res.status(400).json({ error: "playerId required" }); return; } }
  if (typeof adjustmentStrokes !== "number" || isNaN(adjustmentStrokes)) {
    res.status(400).json({ error: "adjustmentStrokes must be a number (upward strokes to add)" });
    return;
  }
  if (adjustmentStrokes <= 0) {
    res.status(400).json({ error: "adjustmentStrokes must be positive (committee adjustments are upward-only)" });
    return;
  }
  if (!adjustmentReason || typeof adjustmentReason !== "string" || adjustmentReason.trim().length === 0) {
    res.status(400).json({ error: "adjustmentReason is mandatory" });
    return;
  }

  if (!await verifyPlayerOrg(playerId, orgId)) {
    res.status(403).json({ error: "Player does not belong to this organization" });
    return;
  }

  const [player] = await db.select().from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  const current = effectiveHcp(player);
  // Compute resulting HI: current + strokes, capped at 54.0
  const resultingHI = Math.min(54.0, (current ?? 0) + adjustmentStrokes);

  // Record audit entry — do NOT auto-update handicapOverride (per task spec: manual update only).
  const [adj] = await db.insert(handicapAdjustmentsTable).values({
    organizationId: orgId,
    playerId,
    adjustedByUserId: req.user?.id ?? null,
    previousHandicapIndex: current != null ? String(current) : null,
    newHandicapIndex: String(resultingHI),
    adjustmentStrokes: String(adjustmentStrokes),
    adjustmentReason: adjustmentReason.trim(),
    committeeNotes: committeeNotes ?? null,
    tournamentId: tournamentId ?? null,
  }).returning();

  // Task #2008 — branded `handicap.committee.changed` dispatch to the player
  // whose HI was adjusted. Mirrors the exceptional-score path; the audit row
  // remains the source of truth, so notify failure must not block the route.
  if (player.userId) {
    void notifyHandicapCommitteeChanged({
      userIds: [player.userId],
      oldIndex: current ?? undefined,
      newIndex: resultingHI,
      reason: adjustmentReason.trim(),
    });
  }

  res.json({
    success: true,
    adjustmentId: adj.id,
    adjustmentStrokes,
    previousHandicapIndex: current,
    resultingHandicapIndex: resultingHI,
    note: "Handicap index update not applied automatically. Committee member should update player HI manually.",
  });
});

/* ─── GET /adjustments — List Adjustments ───────────────────────── */

router.get("/adjustments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  const filterPlayerId = typeof req.query.playerId === "string" ? parseInt(req.query.playerId) : null;

  const conditions = [eq(handicapAdjustmentsTable.organizationId, orgId)];
  if (from && !isNaN(from.getTime())) conditions.push(gte(handicapAdjustmentsTable.adjustedAt, from));
  if (to && !isNaN(to.getTime())) {
    const toEnd = new Date(to); toEnd.setDate(toEnd.getDate() + 1);
    conditions.push(lte(handicapAdjustmentsTable.adjustedAt, toEnd));
  }
  if (filterPlayerId && !isNaN(filterPlayerId)) {
    conditions.push(eq(handicapAdjustmentsTable.playerId, filterPlayerId));
  }

  const rows = await db
    .select({
      id: handicapAdjustmentsTable.id,
      playerId: handicapAdjustmentsTable.playerId,
      previousHandicapIndex: handicapAdjustmentsTable.previousHandicapIndex,
      newHandicapIndex: handicapAdjustmentsTable.newHandicapIndex,
      adjustmentReason: handicapAdjustmentsTable.adjustmentReason,
      committeeNotes: handicapAdjustmentsTable.committeeNotes,
      adjustedAt: handicapAdjustmentsTable.adjustedAt,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      adjusterName: appUsersTable.displayName,
      tournamentName: tournamentsTable.name,
    })
    .from(handicapAdjustmentsTable)
    .innerJoin(playersTable, eq(handicapAdjustmentsTable.playerId, playersTable.id))
    .leftJoin(appUsersTable, eq(handicapAdjustmentsTable.adjustedByUserId, appUsersTable.id))
    .leftJoin(tournamentsTable, eq(handicapAdjustmentsTable.tournamentId, tournamentsTable.id))
    .where(and(...conditions))
    .orderBy(desc(handicapAdjustmentsTable.adjustedAt));

  res.json(rows.map(r => ({
    ...r,
    previousHandicapIndex: r.previousHandicapIndex ? Number(r.previousHandicapIndex) : null,
    newHandicapIndex: Number(r.newHandicapIndex),
    // adjustmentStrokes: the delta applied (positive = handicap raised by committee)
    adjustmentStrokes: r.previousHandicapIndex
      ? Number(r.newHandicapIndex) - Number(r.previousHandicapIndex)
      : null,
    adjustedAt: r.adjustedAt.toISOString(),
  })));
});

/* ─── GET /adjustments/export.csv — Period CSV Export ───────────── */

router.get("/adjustments/export.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;

  const conditions = [eq(handicapAdjustmentsTable.organizationId, orgId)];
  if (from && !isNaN(from.getTime())) conditions.push(gte(handicapAdjustmentsTable.adjustedAt, from));
  if (to && !isNaN(to.getTime())) {
    const toEnd = new Date(to); toEnd.setDate(toEnd.getDate() + 1);
    conditions.push(lte(handicapAdjustmentsTable.adjustedAt, toEnd));
  }

  const rows = await db
    .select({
      id: handicapAdjustmentsTable.id,
      previousHandicapIndex: handicapAdjustmentsTable.previousHandicapIndex,
      newHandicapIndex: handicapAdjustmentsTable.newHandicapIndex,
      adjustmentReason: handicapAdjustmentsTable.adjustmentReason,
      committeeNotes: handicapAdjustmentsTable.committeeNotes,
      adjustedAt: handicapAdjustmentsTable.adjustedAt,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      adjusterName: appUsersTable.displayName,
      tournamentName: tournamentsTable.name,
    })
    .from(handicapAdjustmentsTable)
    .innerJoin(playersTable, eq(handicapAdjustmentsTable.playerId, playersTable.id))
    .leftJoin(appUsersTable, eq(handicapAdjustmentsTable.adjustedByUserId, appUsersTable.id))
    .leftJoin(tournamentsTable, eq(handicapAdjustmentsTable.tournamentId, tournamentsTable.id))
    .where(and(...conditions))
    .orderBy(asc(handicapAdjustmentsTable.adjustedAt));

  const csvRows = [
    ["ID", "Date", "Player Name", "Player Email", "Previous HCP", "New HCP", "Delta", "Reason", "Committee Notes", "Adjusted By", "Tournament"].join(","),
    ...rows.map(r => {
      const prev = r.previousHandicapIndex ? Number(r.previousHandicapIndex) : null;
      const next = Number(r.newHandicapIndex);
      const delta = prev != null ? `+${(next - prev).toFixed(1)}` : "—";
      return [
        r.id,
        r.adjustedAt.toISOString().split("T")[0],
        `"${r.firstName} ${r.lastName}"`,
        `"${r.email ?? ""}"`,
        prev?.toFixed(1) ?? "",
        next.toFixed(1),
        delta,
        `"${(r.adjustmentReason ?? "").replace(/"/g, '""')}"`,
        `"${(r.committeeNotes ?? "").replace(/"/g, '""')}"`,
        `"${r.adjusterName ?? ""}"`,
        `"${r.tournamentName ?? ""}"`,
      ].join(",");
    }),
  ].join("\n");

  const fromStr = from ? from.toISOString().split("T")[0] : "all";
  const toStr = to ? to.toISOString().split("T")[0] : "today";
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="handicap-adjustments-${fromStr}-to-${toStr}.csv"`);
  res.send(csvRows);
});

/* ─── GET /stats — Committee Overview ───────────────────────────── */

router.get("/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const pendingESR = await db.select({ n: count() })
    .from(exceptionalScoreFlagsTable)
    .where(and(eq(exceptionalScoreFlagsTable.organizationId, orgId), eq(exceptionalScoreFlagsTable.status, "pending")))
    .then(r => Number(r[0]?.n ?? 0));

  const totalAdjustments = await db.select({ n: count() })
    .from(handicapAdjustmentsTable)
    .where(eq(handicapAdjustmentsTable.organizationId, orgId))
    .then(r => Number(r[0]?.n ?? 0));

  const tournaments = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
  const tids = tournaments.map(t => t.id);

  let avgHcp: number | null = null;
  let totalPlayers = 0;
  let withOverride = 0;

  if (tids.length > 0) {
    const pStats = await db.select({
      total: count(),
      withOverride: sql<number>`count(case when ${playersTable.handicapOverride} is not null then 1 end)::int`,
      avg: avg(sql<number>`case when ${playersTable.handicapOverride} is not null then ${playersTable.handicapOverride}::numeric else ${playersTable.handicapIndex}::numeric end`),
    }).from(playersTable).where(inArray(playersTable.tournamentId, tids)).then(r => r[0]);

    totalPlayers = Number(pStats?.total ?? 0);
    withOverride = Number(pStats?.withOverride ?? 0);
    avgHcp = pStats?.avg != null ? Math.round(Number(pStats.avg) * 10) / 10 : null;
  }

  res.json({ pendingESR, totalAdjustments, totalPlayers, withOverride, avgHcp });
});

export default router;
