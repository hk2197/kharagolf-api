import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { tournamentRoundsTable, tournamentsTable, coursesTable, orgMembershipsTable } from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

// GET /organizations/:orgId/tournaments/:tournamentId/rounds
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const rounds = await db.select({
    id: tournamentRoundsTable.id,
    roundNumber: tournamentRoundsTable.roundNumber,
    courseId: tournamentRoundsTable.courseId,
    scheduledDate: tournamentRoundsTable.scheduledDate,
    notes: tournamentRoundsTable.notes,
    courseName: coursesTable.name,
  }).from(tournamentRoundsTable)
    .leftJoin(coursesTable, eq(tournamentRoundsTable.courseId, coursesTable.id))
    .where(eq(tournamentRoundsTable.tournamentId, tournamentId))
    .orderBy(asc(tournamentRoundsTable.roundNumber));

  res.json(rounds);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/rounds/:roundNumber
// Upserts the course assignment for a specific round
router.put("/:roundNumber", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const roundNumber = parseInt(String((req.params as Record<string, string>).roundNumber));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [tournament] = await db.select({ id: tournamentsTable.id, rounds: tournamentsTable.rounds })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  if (roundNumber < 1 || roundNumber > tournament.rounds) {
    res.status(400).json({ error: `Round number must be between 1 and ${tournament.rounds}` }); return;
  }

  const { courseId, scheduledDate, notes } = req.body;

  const existing = await db.select({ id: tournamentRoundsTable.id })
    .from(tournamentRoundsTable)
    .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, roundNumber)));

  if (existing[0]) {
    const [updated] = await db.update(tournamentRoundsTable).set({
      courseId: courseId ?? null,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      notes: notes ?? null,
    }).where(eq(tournamentRoundsTable.id, existing[0].id)).returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(tournamentRoundsTable).values({
      tournamentId,
      roundNumber,
      courseId: courseId ?? null,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      notes: notes ?? null,
    }).returning();
    res.status(201).json(created);
  }
});

// GET /organizations/:orgId/tournaments/:tournamentId/rounds/:roundNumber/course
// Fetches the course for the specific round (mobile scoring uses this)
router.get("/:roundNumber/course", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const roundNumber = parseInt(String((req.params as Record<string, string>).roundNumber));

  const [row] = await db.select({
    courseId: tournamentRoundsTable.courseId,
    scheduledDate: tournamentRoundsTable.scheduledDate,
    courseName: coursesTable.name,
    courseSlope: coursesTable.slope,
    courseCr: coursesTable.rating,
  }).from(tournamentRoundsTable)
    .leftJoin(coursesTable, eq(tournamentRoundsTable.courseId, coursesTable.id))
    .where(and(
      eq(tournamentRoundsTable.tournamentId, tournamentId),
      eq(tournamentRoundsTable.roundNumber, roundNumber),
    ));

  if (!row) {
    // Fallback: return tournament's default course
    const [tournament] = await db.select({
      courseId: tournamentsTable.courseId,
      courseName: coursesTable.name,
    }).from(tournamentsTable)
      .leftJoin(coursesTable, eq(tournamentsTable.courseId, coursesTable.id))
      .where(eq(tournamentsTable.id, tournamentId));
    res.json(tournament ?? null);
    return;
  }

  res.json(row);
});

export default router;
