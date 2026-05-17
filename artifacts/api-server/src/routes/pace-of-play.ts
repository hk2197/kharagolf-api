/**
 * Pace of Play routes (Task #107)
 *
 * Configuration (admin):
 *   GET/PUT /organizations/:orgId/courses/:courseId/hole-par-times
 *   GET/PUT /organizations/:orgId/tournaments/:tournamentId/pace-settings
 *
 * Checkpoint API (marshals):
 *   POST /organizations/:orgId/tournaments/:tournamentId/checkpoints
 *   GET  /organizations/:orgId/tournaments/:tournamentId/checkpoints?round=1&teeTimeId=X
 *
 * Marshal live board:
 *   GET /organizations/:orgId/tournaments/:tournamentId/pace-board
 *   GET /sse/pace/:tournamentId
 *
 * Alerts:
 *   GET  /organizations/:orgId/tournaments/:tournamentId/pace-alerts
 *   POST /organizations/:orgId/tournaments/:tournamentId/pace-alerts/:alertId/acknowledge
 *
 * Reporting:
 *   GET /organizations/:orgId/tournaments/:tournamentId/pace-report
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  holeParTimesTable, paceAlertSettingsTable, groupCheckpointsTable,
  groupPaceRecordsTable, paceAlertsTable,
  teeTimesTable, teeTimePlayersTable, playersTable, scoresTable,
  tournamentsTable, holeDetailsTable, tournamentRoundsTable,
  appUsersTable, orgMembershipsTable, tournamentStaffTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { requireOrgAdmin, requireTournamentAccess } from "../lib/permissions";
import { addPaceClient, removePaceClient, notifyPaceUpdate } from "../lib/realtime";
import { sendPushToUsers } from "../lib/push";

const router: IRouter = Router({ mergeParams: true });

// ─── Marshal Access Guard ────────────────────────────────────────────────────

/**
 * Allow access for org admins, tournament directors, tournament staff, AND
 * org members with "volunteer" role — so marshals on-course can submit check-ins.
 */
async function requireMarshalOrAdminAccess(
  req: Request,
  res: Response,
  orgId: number,
  tournamentId: number,
): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  const [tournament] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found." });
    return false;
  }

  const user = req.user as { id: number; role?: string; organizationId?: number } | undefined;
  if (!user?.id) { res.status(401).json({ error: "Authentication required." }); return false; }

  if (user.role === "super_admin") return true;
  if (
    ["org_admin", "tournament_director"].includes(user.role ?? "") &&
    user.organizationId === orgId
  ) return true;

  // Tournament-scoped staff
  const [tStaff] = await db
    .select({ id: tournamentStaffTable.userId })
    .from(tournamentStaffTable)
    .where(and(eq(tournamentStaffTable.tournamentId, tournamentId), eq(tournamentStaffTable.userId, user.id)));
  if (tStaff) return true;

  // Volunteer/marshal role in the org
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (membership && ["org_admin", "tournament_director", "volunteer", "marshal"].includes(membership.role)) return true;

  res.status(403).json({ error: "Marshal or admin access required." });
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the effective current hole for a tee-time group.
 * Priority: latest manual marshal checkpoint > highest score submitted.
 */
async function resolveGroupHole(
  teeTimeId: number,
  tournamentId: number,
  round: number,
  playerIds: number[],
): Promise<{ currentHole: number; lastHoleCompletedAt: Date | null }> {
  // 1. Check manual checkpoints first (most authoritative)
  const [latestCheckpoint] = await db
    .select({
      holeNumber: groupCheckpointsTable.holeNumber,
      checkedInAt: groupCheckpointsTable.checkedInAt,
    })
    .from(groupCheckpointsTable)
    .where(and(
      eq(groupCheckpointsTable.teeTimeId, teeTimeId),
      eq(groupCheckpointsTable.tournamentId, tournamentId),
      eq(groupCheckpointsTable.round, round),
    ))
    .orderBy(desc(groupCheckpointsTable.checkedInAt))
    .limit(1);

  if (latestCheckpoint) {
    return {
      currentHole: latestCheckpoint.holeNumber,
      lastHoleCompletedAt: latestCheckpoint.checkedInAt,
    };
  }

  // 2. Fall back to score submissions
  if (playerIds.length === 0) return { currentHole: 0, lastHoleCompletedAt: null };

  const holeScores = await db
    .select({
      holeNumber: scoresTable.holeNumber,
      submittedAt: scoresTable.submittedAt,
    })
    .from(scoresTable)
    .where(and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.round, round),
      sql`${scoresTable.playerId} = ANY(ARRAY[${sql.join(playerIds.map(id => sql`${id}`), sql`, `)}]::int[])`,
    ))
    .orderBy(desc(scoresTable.holeNumber), desc(scoresTable.submittedAt));

  const holeMap = new Map<number, Date>();
  for (const s of holeScores) {
    if (!holeMap.has(s.holeNumber)) holeMap.set(s.holeNumber, s.submittedAt);
  }

  if (holeMap.size === 0) return { currentHole: 0, lastHoleCompletedAt: null };

  const currentHole = Math.max(...holeMap.keys());
  return { currentHole, lastHoleCompletedAt: holeMap.get(currentHole) ?? null };
}

/**
 * Compute the pace snapshot for every tee-time group in a tournament round.
 * Returns an array of group pace objects ready to send to the client.
 */
async function computePaceBoard(tournamentId: number, round: number) {
  const [tournament] = await db
    .select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament?.courseId) return [];

  const [roundRow] = await db
    .select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(and(
      eq(tournamentRoundsTable.tournamentId, tournamentId),
      eq(tournamentRoundsTable.roundNumber, round),
    ));
  const effectiveCourseId = roundRow?.courseId ?? tournament.courseId;

  const parTimes = await db
    .select({ holeNumber: holeParTimesTable.holeNumber, parMinutes: holeParTimesTable.parMinutes })
    .from(holeParTimesTable)
    .where(eq(holeParTimesTable.courseId, effectiveCourseId))
    .orderBy(asc(holeParTimesTable.holeNumber));

  const cumulativeTarget: Record<number, number> = {};
  let cumulative = 0;
  for (const pt of parTimes) {
    cumulative += pt.parMinutes;
    cumulativeTarget[pt.holeNumber] = cumulative;
  }
  const defaultParMinutes = 14;

  const teeTimes = await db
    .select()
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, round)))
    .orderBy(asc(teeTimesTable.teeTime));

  const now = new Date();
  const groups = [];

  for (const tt of teeTimes) {
    const ttPlayers = await db
      .select({
        playerId: teeTimePlayersTable.playerId,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

    if (ttPlayers.length === 0) continue;

    const playerIds = ttPlayers.map(p => p.playerId);

    const { currentHole, lastHoleCompletedAt } = await resolveGroupHole(
      tt.id, tournamentId, round, playerIds,
    );

    const teeTimeMs = tt.teeTime.getTime();
    const actualElapsedMinutes = Math.max(0, Math.floor((now.getTime() - teeTimeMs) / 60000));

    let targetElapsedMinutes = 0;
    if (currentHole > 0) {
      targetElapsedMinutes = cumulativeTarget[currentHole] ?? (currentHole * defaultParMinutes);
    }

    const deviationMinutes = actualElapsedMinutes - targetElapsedMinutes;

    groups.push({
      teeTimeId: tt.id,
      teeTime: tt.teeTime.toISOString(),
      round,
      startingHole: tt.startingHole,
      players: ttPlayers.map(p => ({ id: p.playerId, name: `${p.firstName} ${p.lastName}` })),
      currentHole,
      actualElapsedMinutes,
      targetElapsedMinutes,
      deviationMinutes,
      lastHoleCompletedAt: lastHoleCompletedAt?.toISOString() ?? null,
    });
  }

  return groups;
}

/**
 * Compute pace status string from deviation and thresholds.
 */
function paceStatus(deviation: number, warning: number, critical: number): string {
  if (deviation >= critical) return "critical";
  if (deviation >= warning) return "warning";
  return "on_pace";
}

/**
 * Run pace engine for a tournament after a score submission or checkpoint.
 * Upserts group_pace_records, creates pace_alerts if needed, and broadcasts SSE.
 */
export async function runPaceEngine(tournamentId: number, round: number): Promise<void> {
  try {
    const [settings] = await db
      .select()
      .from(paceAlertSettingsTable)
      .where(eq(paceAlertSettingsTable.tournamentId, tournamentId));
    const warningThreshold = settings?.warningThresholdMinutes ?? 10;
    const criticalThreshold = settings?.criticalThresholdMinutes ?? 20;

    const groups = await computePaceBoard(tournamentId, round);

    for (const g of groups) {
      const status = paceStatus(g.deviationMinutes, warningThreshold, criticalThreshold);

      await db
        .insert(groupPaceRecordsTable)
        .values({
          tournamentId,
          teeTimeId: g.teeTimeId,
          round,
          currentHole: g.currentHole,
          actualElapsedMinutes: g.actualElapsedMinutes,
          targetElapsedMinutes: g.targetElapsedMinutes,
          deviationMinutes: g.deviationMinutes,
          paceStatus: status,
          lastHoleCompletedAt: g.lastHoleCompletedAt ? new Date(g.lastHoleCompletedAt) : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [groupPaceRecordsTable.teeTimeId, groupPaceRecordsTable.round],
          set: {
            currentHole: g.currentHole,
            actualElapsedMinutes: g.actualElapsedMinutes,
            targetElapsedMinutes: g.targetElapsedMinutes,
            deviationMinutes: g.deviationMinutes,
            paceStatus: status,
            lastHoleCompletedAt: g.lastHoleCompletedAt ? new Date(g.lastHoleCompletedAt) : null,
            updatedAt: new Date(),
          },
        });

      if (status !== "on_pace" && g.currentHole > 0) {
        const [existingAlert] = await db
          .select({ id: paceAlertsTable.id })
          .from(paceAlertsTable)
          .where(and(
            eq(paceAlertsTable.teeTimeId, g.teeTimeId),
            eq(paceAlertsTable.round, round),
            sql`${paceAlertsTable.acknowledgedAt} IS NULL`,
          ));

        if (!existingAlert) {
          await db.insert(paceAlertsTable).values({
            tournamentId,
            teeTimeId: g.teeTimeId,
            round,
            alertType: status,
            deviationMinutes: g.deviationMinutes,
            currentHole: g.currentHole,
          });

          // Send push notification to tournament staff/org admins
          const playerNames = g.players.map(p => p.name).join(", ");
          const label = status === "critical" ? "Critically Behind" : "Behind Schedule";
          const pushTitle = `⚠️ Pace Alert — ${label}`;
          const pushBody = `${playerNames} • +${g.deviationMinutes}m • Hole ${g.currentHole}`;

          const [tournament] = await db
            .select({ organizationId: tournamentsTable.organizationId })
            .from(tournamentsTable)
            .where(eq(tournamentsTable.id, tournamentId));

          if (tournament) {
            const adminUsers = await db
              .select({ id: appUsersTable.id })
              .from(appUsersTable)
              .where(and(
                eq(appUsersTable.organizationId, tournament.organizationId),
                sql`${appUsersTable.role} IN ('org_admin', 'tournament_director')`,
              ));

            const staffUsers = await db
              .select({ userId: tournamentStaffTable.userId })
              .from(tournamentStaffTable)
              .where(eq(tournamentStaffTable.tournamentId, tournamentId));

            const allUserIds = [
              ...adminUsers.map(u => u.id),
              ...staffUsers.map(u => u.userId),
            ].filter((id): id is number => id != null).filter((id, i, arr) => arr.indexOf(id) === i);

            if (allUserIds.length > 0) {
              // Task #1240 — fire-and-forget (`.catch(() => {})`); no
              // delivery telemetry consumed downstream, classifier
              // intentionally not used.
              sendPushToUsers(allUserIds, pushTitle, pushBody, {
                type: "pace_alert",
                tournamentId,
                teeTimeId: g.teeTimeId,
                alertType: status,
              }).catch(() => {});
            }
          }
        }
      }
    }

    notifyPaceUpdate(tournamentId, {
      groups: groups.map(g => ({
        ...g,
        paceStatus: paceStatus(g.deviationMinutes, warningThreshold, criticalThreshold),
      })),
      settings: { warningThreshold, criticalThreshold },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[pace-engine] error:", err);
  }
}

// ─── Course Par Times ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/courses/:courseId/hole-par-times
router.get("/courses/:courseId/hole-par-times", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const courseId = parseInt(String((req.params as Record<string, string>).courseId));

  const holes = await db
    .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId))
    .orderBy(asc(holeDetailsTable.holeNumber));

  const parTimes = await db
    .select()
    .from(holeParTimesTable)
    .where(eq(holeParTimesTable.courseId, courseId))
    .orderBy(asc(holeParTimesTable.holeNumber));

  const parTimeMap = new Map(parTimes.map(pt => [pt.holeNumber, pt]));

  const result = holes.map(h => ({
    holeNumber: h.holeNumber,
    par: h.par,
    parMinutes: parTimeMap.get(h.holeNumber)?.parMinutes ?? 14,
    id: parTimeMap.get(h.holeNumber)?.id ?? null,
  }));

  res.json(result);
});

// PUT /organizations/:orgId/courses/:courseId/hole-par-times
router.put("/courses/:courseId/hole-par-times", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const { parTimes } = req.body as { parTimes: Array<{ holeNumber: number; parMinutes: number }> };

  if (!Array.isArray(parTimes) || parTimes.length === 0) {
    res.status(400).json({ error: "parTimes array is required" });
    return;
  }

  for (const pt of parTimes) {
    if (typeof pt.holeNumber !== "number" || typeof pt.parMinutes !== "number" || pt.parMinutes < 1) {
      res.status(400).json({ error: "Each parTime must have holeNumber and parMinutes >= 1" });
      return;
    }
    await db
      .insert(holeParTimesTable)
      .values({ courseId, holeNumber: pt.holeNumber, parMinutes: pt.parMinutes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [holeParTimesTable.courseId, holeParTimesTable.holeNumber],
        set: { parMinutes: pt.parMinutes, updatedAt: new Date() },
      });
  }

  res.json({ success: true });
});

// ─── Tournament Pace Settings ────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/pace-settings
router.get("/:tournamentId/pace-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [settings] = await db
    .select()
    .from(paceAlertSettingsTable)
    .where(eq(paceAlertSettingsTable.tournamentId, tournamentId));

  res.json(settings ?? { warningThresholdMinutes: 10, criticalThresholdMinutes: 20 });
});

// PUT /organizations/:orgId/tournaments/:tournamentId/pace-settings
router.put("/:tournamentId/pace-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { warningThresholdMinutes, criticalThresholdMinutes } = req.body;

  if (
    typeof warningThresholdMinutes !== "number" ||
    typeof criticalThresholdMinutes !== "number" ||
    warningThresholdMinutes < 1 ||
    criticalThresholdMinutes <= warningThresholdMinutes
  ) {
    res.status(400).json({ error: "warningThresholdMinutes and criticalThresholdMinutes (> warning) are required" });
    return;
  }

  await db
    .insert(paceAlertSettingsTable)
    .values({ tournamentId, warningThresholdMinutes, criticalThresholdMinutes, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [paceAlertSettingsTable.tournamentId],
      set: { warningThresholdMinutes, criticalThresholdMinutes, updatedAt: new Date() },
    });

  res.json({ success: true });
});

// ─── Group Checkpoints (Marshal Check-ins) ────────────────────────────────────

/**
 * POST /organizations/:orgId/tournaments/:tournamentId/checkpoints
 * Record a marshal check-in or GPS-based position update for a group.
 * Accessible to org admins, tournament directors, tournament staff, and volunteers/marshals.
 * Body: { teeTimeId, round, holeNumber, source?, latitude?, longitude?, notes?, checkedInAt? }
 */
router.post("/:tournamentId/checkpoints", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireMarshalOrAdminAccess(req, res, orgId, tournamentId)) return;

  const user = req.user as { id?: number } | undefined;
  const { teeTimeId, round, holeNumber, source, latitude, longitude, notes, checkedInAt } = req.body as {
    teeTimeId: number;
    round: number;
    holeNumber: number;
    source?: string;
    latitude?: string;
    longitude?: string;
    notes?: string;
    checkedInAt?: string;
  };

  if (!teeTimeId || !round || !holeNumber) {
    res.status(400).json({ error: "teeTimeId, round, and holeNumber are required" });
    return;
  }

  const [teeTime] = await db
    .select({ id: teeTimesTable.id })
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));

  if (!teeTime) {
    res.status(404).json({ error: "Tee time not found in this tournament" });
    return;
  }

  const [checkpoint] = await db
    .insert(groupCheckpointsTable)
    .values({
      tournamentId,
      teeTimeId,
      round,
      holeNumber,
      source: source ?? "marshal",
      recordedByUserId: user?.id ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      notes: notes ?? null,
      checkedInAt: checkedInAt ? new Date(checkedInAt) : new Date(),
    })
    .returning();

  runPaceEngine(tournamentId, round).catch(() => {});

  res.status(201).json(checkpoint);
});

/**
 * GET /organizations/:orgId/tournaments/:tournamentId/checkpoints
 * List checkpoints for a tournament/round (optionally filter by teeTimeId).
 */
router.get("/:tournamentId/checkpoints", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireMarshalOrAdminAccess(req, res, orgId, tournamentId)) return;

  const round = req.query.round ? parseInt(req.query.round as string) : null;
  const teeTimeId = req.query.teeTimeId ? parseInt(req.query.teeTimeId as string) : null;

  const conditions = [eq(groupCheckpointsTable.tournamentId, tournamentId)];
  if (round) conditions.push(eq(groupCheckpointsTable.round, round));
  if (teeTimeId) conditions.push(eq(groupCheckpointsTable.teeTimeId, teeTimeId));

  const checkpoints = await db
    .select()
    .from(groupCheckpointsTable)
    .where(and(...conditions))
    .orderBy(desc(groupCheckpointsTable.checkedInAt));

  res.json(checkpoints);
});

// ─── Marshal Live Board ──────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/pace-board?round=1
router.get("/:tournamentId/pace-board", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const round = parseInt((req.query.round as string) ?? "1") || 1;

  const [settings] = await db
    .select()
    .from(paceAlertSettingsTable)
    .where(eq(paceAlertSettingsTable.tournamentId, tournamentId));
  const warningThreshold = settings?.warningThresholdMinutes ?? 10;
  const criticalThreshold = settings?.criticalThresholdMinutes ?? 20;

  const groups = await computePaceBoard(tournamentId, round);

  const result = groups.map(g => ({
    ...g,
    paceStatus: paceStatus(g.deviationMinutes, warningThreshold, criticalThreshold),
  }));

  res.json({
    groups: result,
    settings: { warningThreshold, criticalThreshold },
    updatedAt: new Date().toISOString(),
  });
});

// ─── Pace Alerts ─────────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/pace-alerts?round=1&unacknowledged=true
router.get("/:tournamentId/pace-alerts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const round = req.query.round ? parseInt(req.query.round as string) : null;
  const unacknowledgedOnly = req.query.unacknowledged === "true";

  const conditions = [eq(paceAlertsTable.tournamentId, tournamentId)];
  if (round) conditions.push(eq(paceAlertsTable.round, round));
  if (unacknowledgedOnly) conditions.push(sql`${paceAlertsTable.acknowledgedAt} IS NULL`);

  const alerts = await db
    .select({
      id: paceAlertsTable.id,
      teeTimeId: paceAlertsTable.teeTimeId,
      round: paceAlertsTable.round,
      alertType: paceAlertsTable.alertType,
      deviationMinutes: paceAlertsTable.deviationMinutes,
      currentHole: paceAlertsTable.currentHole,
      acknowledgedAt: paceAlertsTable.acknowledgedAt,
      createdAt: paceAlertsTable.createdAt,
      teeTime: teeTimesTable.teeTime,
    })
    .from(paceAlertsTable)
    .leftJoin(teeTimesTable, eq(teeTimesTable.id, paceAlertsTable.teeTimeId))
    .where(and(...conditions))
    .orderBy(desc(paceAlertsTable.createdAt));

  const enriched = await Promise.all(alerts.map(async (alert) => {
    const players = await db
      .select({ firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, alert.teeTimeId));
    return {
      ...alert,
      teeTime: alert.teeTime?.toISOString(),
      players: players.map(p => `${p.firstName} ${p.lastName}`),
    };
  }));

  res.json(enriched);
});

// POST /organizations/:orgId/tournaments/:tournamentId/pace-alerts/:alertId/acknowledge
router.post("/:tournamentId/pace-alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const alertId = parseInt(String((req.params as Record<string, string>).alertId));
  const user = req.user as { id?: number } | undefined;

  const [alert] = await db
    .select({ id: paceAlertsTable.id })
    .from(paceAlertsTable)
    .where(and(eq(paceAlertsTable.id, alertId), eq(paceAlertsTable.tournamentId, tournamentId)));

  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  await db
    .update(paceAlertsTable)
    .set({ acknowledgedAt: new Date(), acknowledgedByUserId: user?.id ?? null })
    .where(eq(paceAlertsTable.id, alertId));

  res.json({ success: true });
});

// ─── Post-round Pace Report ──────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/pace-report?round=1
router.get("/:tournamentId/pace-report", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const round = parseInt((req.query.round as string) ?? "1") || 1;

  const holeStats = await db
    .select({
      holeNumber: scoresTable.holeNumber,
      avgSubmittedAt: sql<string>`AVG(EXTRACT(EPOCH FROM ${scoresTable.submittedAt}))`,
      count: sql<number>`COUNT(DISTINCT ${scoresTable.playerId})`,
    })
    .from(scoresTable)
    .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.round, round)))
    .groupBy(scoresTable.holeNumber)
    .orderBy(asc(scoresTable.holeNumber));

  const [tournament] = await db
    .select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  let parTimeMap = new Map<number, number>();
  if (tournament?.courseId) {
    const [roundRow] = await db
      .select({ courseId: tournamentRoundsTable.courseId })
      .from(tournamentRoundsTable)
      .where(and(
        eq(tournamentRoundsTable.tournamentId, tournamentId),
        eq(tournamentRoundsTable.roundNumber, round),
      ));
    const courseId = roundRow?.courseId ?? tournament.courseId;
    const pts = await db
      .select({ holeNumber: holeParTimesTable.holeNumber, parMinutes: holeParTimesTable.parMinutes })
      .from(holeParTimesTable)
      .where(eq(holeParTimesTable.courseId, courseId));
    parTimeMap = new Map(pts.map(p => [p.holeNumber, p.parMinutes]));
  }

  const paceRecords = await db
    .select()
    .from(groupPaceRecordsTable)
    .where(and(eq(groupPaceRecordsTable.tournamentId, tournamentId), eq(groupPaceRecordsTable.round, round)));

  const alertCounts = await db
    .select({
      alertType: paceAlertsTable.alertType,
      count: sql<number>`COUNT(*)`,
    })
    .from(paceAlertsTable)
    .where(and(eq(paceAlertsTable.tournamentId, tournamentId), eq(paceAlertsTable.round, round)))
    .groupBy(paceAlertsTable.alertType);

  const checkpointCounts = await db
    .select({
      holeNumber: groupCheckpointsTable.holeNumber,
      count: sql<number>`COUNT(*)`,
    })
    .from(groupCheckpointsTable)
    .where(and(eq(groupCheckpointsTable.tournamentId, tournamentId), eq(groupCheckpointsTable.round, round)))
    .groupBy(groupCheckpointsTable.holeNumber)
    .orderBy(asc(groupCheckpointsTable.holeNumber));

  const slowestGroups = paceRecords
    .sort((a, b) => b.deviationMinutes - a.deviationMinutes)
    .slice(0, 5)
    .map(r => ({
      teeTimeId: r.teeTimeId,
      currentHole: r.currentHole,
      deviationMinutes: r.deviationMinutes,
      paceStatus: r.paceStatus,
    }));

  const bottleneckHoles = holeStats.map(h => ({
    holeNumber: h.holeNumber,
    playerCount: h.count,
    parMinutes: parTimeMap.get(h.holeNumber) ?? 14,
    checkpoints: checkpointCounts.find(c => c.holeNumber === h.holeNumber)?.count ?? 0,
  }));

  res.json({
    tournamentId,
    round,
    groupCount: paceRecords.length,
    alertCounts,
    slowestGroups,
    bottleneckHoles,
    holeStats,
    checkpointSummary: checkpointCounts,
    generatedAt: new Date().toISOString(),
  });
});

export default router;
