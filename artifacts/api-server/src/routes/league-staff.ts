import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { leagueStaffTable, appUsersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireLeagueAccess } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/leagues/:leagueId/staff
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const staff = await db
    .select({
      id: leagueStaffTable.id,
      leagueId: leagueStaffTable.leagueId,
      userId: leagueStaffTable.userId,
      role: leagueStaffTable.role,
      invitedBy: leagueStaffTable.invitedByUserId,
      createdAt: leagueStaffTable.createdAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
    })
    .from(leagueStaffTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, leagueStaffTable.userId))
    .where(eq(leagueStaffTable.leagueId, leagueId));

  res.json(staff);
});

// POST /organizations/:orgId/leagues/:leagueId/staff
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const { userId, role } = req.body;
  if (!userId || !role) {
    res.status(400).json({ error: "userId and role are required" });
    return;
  }

  const validRoles = ["league_admin", "competition_secretary"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    return;
  }

  const [user] = await db.select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user) { { res.status(404).json({ error: "User not found" }); return; } }

  const [staff] = await db
    .insert(leagueStaffTable)
    .values({
      leagueId,
      organizationId: orgId,
      userId,
      email: user.email ?? "",
      displayName: user.displayName ?? null,
      role,
      invitedByUserId: req.user ? (req.user as unknown as AuthUser).id : null,
    })
    .onConflictDoUpdate({
      target: [leagueStaffTable.leagueId, leagueStaffTable.email],
      set: { role },
    })
    .returning();

  res.status(201).json(staff);
});

// DELETE /organizations/:orgId/leagues/:leagueId/staff/:userId
router.delete("/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const targetUserId = parseInt(String((req.params as Record<string, string>).userId));

  // requireLeagueAccess verifies league belongs to org before granting access
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const deleted = await db
    .delete(leagueStaffTable)
    .where(and(eq(leagueStaffTable.leagueId, leagueId), eq(leagueStaffTable.userId, targetUserId)))
    .returning();

  if (!deleted.length) { { res.status(404).json({ error: "Staff member not found" }); return; } }
  res.status(204).send();
});

export default router;
