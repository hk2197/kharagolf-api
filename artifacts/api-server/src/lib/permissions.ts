import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { orgMembershipsTable, tournamentStaffTable, leagueStaffTable, tournamentsTable, leaguesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/** Cast req.user to the typed AuthUser model. Always guard with req.isAuthenticated() first. */
function getUser(req: Request): AuthUser {
  return req.user as unknown as AuthUser;
}

/**
 * Returns true if the requesting user has org-admin level access to the given org.
 * Checks: super_admin, or (org_admin/tournament_director + matching organizationId), or org_memberships row.
 */
export async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const userOrgId = user.organizationId ?? null;
  if ((user.role === "org_admin" || user.role === "tournament_director") && userOrgId === orgId) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (membership && ["org_admin", "tournament_director"].includes(membership.role)) return true;

  res.status(403).json({ error: "You do not have admin access to this organization." });
  return false;
}

/**
 * Returns true if the requesting user has access to manage the given tournament.
 * Allows: super_admin, org_admin/tournament_director in the same org, tournament_admin staff.
 * Always verifies tournament belongs to the given org.
 */
export async function requireTournamentAccess(
  req: Request,
  res: Response,
  orgId: number,
  tournamentId: number,
): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  // Verify tournament belongs to this org
  const [tournament] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found." });
    return false;
  }

  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const userOrgId = user.organizationId ?? null;
  if ((user.role === "org_admin" || user.role === "tournament_director") && userOrgId === orgId) return true;

  // Org membership check
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (membership && ["org_admin", "tournament_director"].includes(membership.role)) return true;

  // Tournament-scoped staff
  const [tStaff] = await db
    .select({ role: tournamentStaffTable.role })
    .from(tournamentStaffTable)
    .where(and(eq(tournamentStaffTable.tournamentId, tournamentId), eq(tournamentStaffTable.userId, user.id)));

  if (tStaff && tStaff.role === "tournament_admin") return true;

  res.status(403).json({ error: "You do not have access to manage this tournament." });
  return false;
}

/**
 * Returns true if the requesting user has access to manage the given league.
 * Allows: super_admin, org_admin/tournament_director in the same org, league_admin staff.
 * Always verifies league belongs to the given org.
 */
export async function requireLeagueAccess(
  req: Request,
  res: Response,
  orgId: number,
  leagueId: number,
): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  // Verify league belongs to this org
  const [league] = await db
    .select({ organizationId: leaguesTable.organizationId })
    .from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) {
    res.status(404).json({ error: "League not found." });
    return false;
  }

  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const userOrgId = user.organizationId ?? null;
  if ((user.role === "org_admin" || user.role === "tournament_director") && userOrgId === orgId) return true;

  // Org membership check
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (membership && ["org_admin", "tournament_director"].includes(membership.role)) return true;

  // League-scoped staff
  const [lStaff] = await db
    .select({ role: leagueStaffTable.role })
    .from(leagueStaffTable)
    .where(and(eq(leagueStaffTable.leagueId, leagueId), eq(leagueStaffTable.userId, user.id)));

  if (lStaff && ["league_admin", "competition_secretary"].includes(lStaff.role)) return true;

  res.status(403).json({ error: "You do not have access to manage this league." });
  return false;
}

/**
 * Returns true if the requesting user has handicap committee access to the given org.
 * Allows: super_admin, org_admin, tournament_director, committee_member (by user.role or org_membership).
 */
export async function requireCommitteeMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const COMMITTEE_ROLES = ["org_admin", "tournament_director", "committee_member", "competition_secretary"];
  const userOrgId = user.organizationId ?? null;
  if (COMMITTEE_ROLES.includes(user.role) && userOrgId === orgId) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (membership && COMMITTEE_ROLES.includes(membership.role)) return true;

  res.status(403).json({ error: "You do not have handicap committee access to this organization." });
  return false;
}

/**
 * Express middleware version of requireOrgAdmin.
 * Reads orgId from (req.params as Record<string, string>).orgId automatically.
 */
export function orgAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  requireOrgAdmin(req, res, orgId).then(ok => { if (ok) next(); }).catch(next);
}

/**
 * Express middleware version of requireLeagueAccess.
 * Reads orgId from (req.params as Record<string, string>).orgId and leagueId from (req.params as Record<string, string>).leagueId automatically.
 */
export function leagueAccessMiddleware(req: Request, res: Response, next: NextFunction): void {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId), 10);
  requireLeagueAccess(req, res, orgId, leagueId).then(ok => { if (ok) next(); }).catch(next);
}

/**
 * Express middleware that blocks scorer PIN sessions from accessing admin/non-scoring routes.
 * Apply to any route group that must never be reachable from a kiosk scorer session.
 */
export function blockScorerSessions(req: Request, res: Response, next: NextFunction): void {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return;
  }
  next();
}

/**
 * Verifies that the current request is allowed to submit scores for the given tournament.
 * - Scorer PIN session: allowed only if scoped to exactly this tournament.
 * - Full user: super_admin, or org_admin/tournament_director in the tournament's org,
 *   or tournament_admin/live_scorer scoped staff for this tournament.
 * Always verifies the tournament belongs to the given org.
 */
export async function requireScorerAccess(
  req: Request,
  res: Response,
  orgId: number,
  tournamentId: number,
): Promise<boolean> {
  // Allow scorer PIN sessions scoped to this exact tournament
  if (req.scorerSession) {
    if (req.scorerSession.tournamentId !== tournamentId) {
      res.status(403).json({ error: "Scorer credentials are not valid for this tournament." });
      return false;
    }
    // Still verify the tournament belongs to the org in the URL
    const [t] = await db
      .select({ organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
    if (!t) {
      res.status(404).json({ error: "Tournament not found." });
      return false;
    }
    return true;
  }

  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  // Verify tournament belongs to this org
  const [tournament] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found." });
    return false;
  }

  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const userOrgId = user.organizationId ?? null;
  if ((user.role === "org_admin" || user.role === "tournament_director") && userOrgId === orgId) return true;

  // Org membership check
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (membership && ["org_admin", "tournament_director"].includes(membership.role)) return true;

  // Check tournament-scoped staff with scoring roles
  const [tStaff] = await db
    .select({ role: tournamentStaffTable.role })
    .from(tournamentStaffTable)
    .where(and(
      eq(tournamentStaffTable.tournamentId, tournamentId),
      eq(tournamentStaffTable.userId, user.id),
    ));

  if (tStaff && ["tournament_admin", "live_scorer"].includes(tStaff.role)) return true;

  res.status(403).json({ error: "You do not have score-entry access for this tournament." });
  return false;
}
