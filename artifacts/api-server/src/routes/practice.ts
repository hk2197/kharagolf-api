import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { practiceSessionsTable, playersTable, tournamentsTable, roundSubmissionsTable } from "@workspace/db";
import { eq, and, desc, gte, sql, count } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

function getAuthUser(req: Request) {
  return req.user as { id: number; role?: string; organizationId?: number } | undefined;
}

// POST /api/organizations/:orgId/practice — Log a new practice session
router.post("/", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const { sessionType, durationMinutes, notes, clubFocus, sessionDate, playerId } = req.body;

  const [session] = await db.insert(practiceSessionsTable).values({
    userId: user.id,
    organizationId: orgId,
    playerId: playerId ?? null,
    sessionType: sessionType ?? "range",
    durationMinutes: durationMinutes ?? null,
    notes: notes ?? null,
    clubFocus: clubFocus ?? null,
    sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
  }).returning();

  res.status(201).json(session);
});

// GET /api/organizations/:orgId/practice — List practice sessions for the current user
router.get("/", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const sessions = await db.select().from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.userId, user.id),
      eq(practiceSessionsTable.organizationId, orgId),
    ))
    .orderBy(desc(practiceSessionsTable.sessionDate))
    .limit(limit);

  res.json(sessions);
});

// DELETE /api/organizations/:orgId/practice/:sessionId
router.delete("/:sessionId", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  const [deleted] = await db.delete(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.id, sessionId), eq(practiceSessionsTable.userId, user.id)))
    .returning({ id: practiceSessionsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Session not found or not yours" }); return; } }
  res.json({ ok: true });
});

// GET /api/organizations/:orgId/practice/stats — Streak + weekly/monthly counts
router.get("/stats", async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const sessions = await db.select({
    id: practiceSessionsTable.id,
    sessionDate: practiceSessionsTable.sessionDate,
  }).from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.userId, user.id),
      eq(practiceSessionsTable.organizationId, orgId),
      gte(practiceSessionsTable.sessionDate, yearAgo),
    ))
    .orderBy(desc(practiceSessionsTable.sessionDate));

  const thisWeek = sessions.filter(s => new Date(s.sessionDate) >= weekAgo).length;
  const thisMonth = sessions.filter(s => new Date(s.sessionDate) >= monthAgo).length;

  // Compute current streak (consecutive days with at least one session)
  let streak = 0;
  const seenDays = new Set<string>();
  for (const s of sessions) {
    const day = new Date(s.sessionDate).toISOString().slice(0, 10);
    seenDays.add(day);
  }

  const today = new Date();
  let checkDate = new Date(today);
  checkDate.setHours(0, 0, 0, 0);
  while (true) {
    const key = checkDate.toISOString().slice(0, 10);
    if (seenDays.has(key)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Heatmap data — 52 weeks of session dates grouped by day
  const heatmap: Record<string, number> = {};
  for (const s of sessions) {
    const day = new Date(s.sessionDate).toISOString().slice(0, 10);
    heatmap[day] = (heatmap[day] ?? 0) + 1;
  }

  res.json({ thisWeek, thisMonth, streak, total: sessions.length, heatmap });
});

// GET /api/organizations/:orgId/practice/admin — Per-member practice + round counts for admins
router.get("/admin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [practiceRows, roundRows] = await Promise.all([
    db.select({
      userId: practiceSessionsTable.userId,
      sessionCount: count(practiceSessionsTable.id),
    }).from(practiceSessionsTable)
      .where(and(
        eq(practiceSessionsTable.organizationId, orgId),
        gte(practiceSessionsTable.sessionDate, thirtyDaysAgo),
      ))
      .groupBy(practiceSessionsTable.userId),

    db.select({
      userId: playersTable.userId,
      roundCount: count(roundSubmissionsTable.id),
    }).from(roundSubmissionsTable)
      .innerJoin(playersTable, eq(roundSubmissionsTable.playerId, playersTable.id))
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(tournamentsTable.organizationId, orgId),
        gte(roundSubmissionsTable.submittedAt, thirtyDaysAgo),
      ))
      .groupBy(playersTable.userId),
  ]);

  // Merge by userId
  const practiceMap = new Map(practiceRows.filter(r => r.userId != null).map(r => [r.userId!, r.sessionCount]));
  const roundMap = new Map(roundRows.filter(r => r.userId != null).map(r => [r.userId!, Number(r.roundCount)]));
  const allUserIds = new Set([...practiceMap.keys(), ...roundMap.keys()]);

  const merged = Array.from(allUserIds).map(userId => ({
    userId,
    sessionCount: Number(practiceMap.get(userId) ?? 0),
    roundCount: roundMap.get(userId) ?? 0,
  }));

  res.json(merged);
});

export default router;
