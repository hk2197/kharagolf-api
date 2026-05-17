import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { tournamentStaffTable, appUsersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireTournamentAccess } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/tournaments/:tournamentId/staff
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const staff = await db
    .select({
      id: tournamentStaffTable.id,
      tournamentId: tournamentStaffTable.tournamentId,
      userId: tournamentStaffTable.userId,
      role: tournamentStaffTable.role,
      invitedBy: tournamentStaffTable.invitedByUserId,
      createdAt: tournamentStaffTable.createdAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
    })
    .from(tournamentStaffTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, tournamentStaffTable.userId))
    .where(eq(tournamentStaffTable.tournamentId, tournamentId));

  res.json(staff);
});

// POST /organizations/:orgId/tournaments/:tournamentId/staff
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const { userId, role } = req.body;
  if (!userId || !role) {
    res.status(400).json({ error: "userId and role are required" });
    return;
  }

  const validRoles = ["tournament_admin", "live_scorer", "volunteer"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    return;
  }

  const [user] = await db.select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user) { { res.status(404).json({ error: "User not found" }); return; } }

  const [staff] = await db
    .insert(tournamentStaffTable)
    .values({
      tournamentId,
      organizationId: orgId,
      userId,
      email: user.email ?? "",
      displayName: user.displayName ?? null,
      role,
      invitedByUserId: req.user ? (req.user as unknown as AuthUser).id : null,
    })
    .onConflictDoUpdate({
      target: [tournamentStaffTable.tournamentId, tournamentStaffTable.email],
      set: { role },
    })
    .returning();

  res.status(201).json(staff);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/staff/:userId
router.delete("/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const targetUserId = parseInt(String((req.params as Record<string, string>).userId));

  // requireTournamentAccess verifies tournament belongs to org before granting access
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const deleted = await db
    .delete(tournamentStaffTable)
    .where(and(eq(tournamentStaffTable.tournamentId, tournamentId), eq(tournamentStaffTable.userId, targetUserId)))
    .returning();

  if (!deleted.length) { { res.status(404).json({ error: "Staff member not found" }); return; } }
  res.status(204).send();
});

export default router;
