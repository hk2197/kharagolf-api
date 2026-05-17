import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  tournamentStaffTable,
  scorerPinsTable,
  leagueStaffTable,
  appUsersTable,
  tournamentsTable,
  leaguesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createSession, type SessionData, SESSION_COOKIE, SESSION_TTL } from "../lib/auth";

const router: IRouter = Router();

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const role = (req.user as { role?: string }).role;
  if (!["org_admin", "super_admin", "tournament_director"].includes(role ?? "")) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// ─── TOURNAMENT STAFF ─────────────────────────────────────────────────────────

// GET /api/tournaments/:tournamentId/staff
router.get("/tournaments/:tournamentId/staff", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const staff = await db
    .select()
    .from(tournamentStaffTable)
    .where(eq(tournamentStaffTable.tournamentId, tournamentId))
    .orderBy(tournamentStaffTable.createdAt);
  res.json(staff);
});

// POST /api/tournaments/:tournamentId/staff — invite a staff member
router.post("/tournaments/:tournamentId/staff", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { email, role, displayName } = req.body;

  if (!email || !role) {
    res.status(400).json({ error: "email and role are required" });
    return;
  }

  const validRoles = ["tournament_admin", "live_scorer", "volunteer"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }

  const [tournament] = await db.select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const [existing] = await db.select({ id: tournamentStaffTable.id })
    .from(tournamentStaffTable)
    .where(and(
      eq(tournamentStaffTable.tournamentId, tournamentId),
      eq(tournamentStaffTable.email, normalizedEmail),
    ));

  if (existing) {
    res.status(409).json({ error: "This email is already a staff member for this tournament" });
    return;
  }

  const [matchedUser] = await db.select({ id: appUsersTable.id, displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.email, normalizedEmail));

  const [created] = await db.insert(tournamentStaffTable).values({
    tournamentId,
    organizationId: tournament.organizationId,
    userId: matchedUser?.id ?? null,
    email: normalizedEmail,
    displayName: displayName || matchedUser?.displayName || null,
    role: role as "tournament_admin" | "live_scorer" | "volunteer",
    invitedByUserId: (req.user as { id?: number }).id ?? null,
  }).returning();

  res.status(201).json(created);
});

// DELETE /api/tournaments/:tournamentId/staff/:staffId — revoke access
router.delete("/tournaments/:tournamentId/staff/:staffId", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const staffId = parseInt(String((req.params as Record<string, string>).staffId));

  await db.delete(tournamentStaffTable).where(and(
    eq(tournamentStaffTable.id, staffId),
    eq(tournamentStaffTable.tournamentId, tournamentId),
  ));

  res.json({ success: true });
});

// ─── SCORER PINS ──────────────────────────────────────────────────────────────

function generatePin(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pin = "";
  for (let i = 0; i < 6; i++) {
    pin += chars[Math.floor(Math.random() * chars.length)];
  }
  return pin;
}

// GET /api/tournaments/:tournamentId/scorer-pins
router.get("/tournaments/:tournamentId/scorer-pins", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const pins = await db.select()
    .from(scorerPinsTable)
    .where(eq(scorerPinsTable.tournamentId, tournamentId))
    .orderBy(scorerPinsTable.createdAt);
  res.json(pins);
});

// POST /api/tournaments/:tournamentId/scorer-pins — generate a new PIN
router.post("/tournaments/:tournamentId/scorer-pins", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { label, expiresAt } = req.body;

  if (!label) {
    res.status(400).json({ error: "label is required" });
    return;
  }

  const [tournament] = await db.select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  let pin: string;
  let attempts = 0;
  do {
    pin = generatePin();
    attempts++;
    if (attempts > 20) {
      res.status(500).json({ error: "Could not generate unique PIN" });
      return;
    }
    const [existing] = await db.select({ id: scorerPinsTable.id })
      .from(scorerPinsTable)
      .where(and(eq(scorerPinsTable.tournamentId, tournamentId), eq(scorerPinsTable.pin, pin)));
    if (!existing) break;
  } while (true);

  const [created] = await db.insert(scorerPinsTable).values({
    tournamentId,
    organizationId: tournament.organizationId,
    pin,
    label,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    isRevoked: false,
    createdByUserId: (req.user as { id?: number }).id ?? null,
  }).returning();

  res.status(201).json(created);
});

// DELETE /api/tournaments/:tournamentId/scorer-pins/:pinId — revoke a PIN
router.delete("/tournaments/:tournamentId/scorer-pins/:pinId", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const pinId = parseInt(String((req.params as Record<string, string>).pinId));

  await db.update(scorerPinsTable)
    .set({ isRevoked: true })
    .where(and(eq(scorerPinsTable.id, pinId), eq(scorerPinsTable.tournamentId, tournamentId)));

  res.json({ success: true });
});

// POST /api/auth/scorer-login — PIN-based scorer login
router.post("/auth/scorer-login", async (req: Request, res: Response) => {
  const { pin, tournamentId } = req.body;
  if (!pin || !tournamentId) {
    res.status(400).json({ error: "pin and tournamentId are required" });
    return;
  }

  const normalizedPin = pin.toUpperCase().trim();

  const [scorerPin] = await db.select()
    .from(scorerPinsTable)
    .where(and(
      eq(scorerPinsTable.tournamentId, parseInt(tournamentId)),
      eq(scorerPinsTable.pin, normalizedPin),
    ));

  if (!scorerPin) {
    res.status(401).json({ error: "Invalid PIN. Please check and try again." });
    return;
  }

  if (scorerPin.isRevoked) {
    res.status(401).json({ error: "This PIN has been revoked." });
    return;
  }

  if (scorerPin.expiresAt && scorerPin.expiresAt < new Date()) {
    res.status(401).json({ error: "This PIN has expired." });
    return;
  }

  const [tournament] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    organizationId: tournamentsTable.organizationId,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, parseInt(tournamentId)));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: -scorerPin.id,
      replitId: `scorer_pin_${scorerPin.id}`,
      username: `scorer_${normalizedPin}`,
      displayName: scorerPin.label,
      role: "spectator",
      organizationId: scorerPin.organizationId,
      createdAt: new Date().toISOString(),
    },
    access_token: `scorer_${scorerPin.id}`,
    scorerSession: {
      pinId: scorerPin.id,
      tournamentId: scorerPin.tournamentId,
      label: scorerPin.label,
    },
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);

  res.json({
    success: true,
    tournament: { id: tournament.id, name: tournament.name },
    label: scorerPin.label,
  });
});

// GET /api/public/tournaments — public list for scorer login page
router.get("/public/tournaments", async (req: Request, res: Response) => {
  const orgId = req.query.orgId ? parseInt(req.query.orgId as string) : null;

  let query = db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    status: tournamentsTable.status,
    startDate: tournamentsTable.startDate,
    organizationId: tournamentsTable.organizationId,
  }).from(tournamentsTable);

  const rows = orgId
    ? await query.where(eq(tournamentsTable.organizationId, orgId))
    : await query;

  const active = rows.filter(t => ["draft", "upcoming", "active"].includes(t.status));
  res.json(active);
});

// ─── LEAGUE STAFF ─────────────────────────────────────────────────────────────

// GET /api/leagues/:leagueId/staff
router.get("/leagues/:leagueId/staff", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const staff = await db.select()
    .from(leagueStaffTable)
    .where(eq(leagueStaffTable.leagueId, leagueId))
    .orderBy(leagueStaffTable.createdAt);
  res.json(staff);
});

// POST /api/leagues/:leagueId/staff — invite a staff member
router.post("/leagues/:leagueId/staff", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const { email, role, displayName } = req.body;

  if (!email || !role) {
    res.status(400).json({ error: "email and role are required" });
    return;
  }

  const validRoles = ["league_admin", "competition_secretary"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }

  const [league] = await db.select({ organizationId: leaguesTable.organizationId })
    .from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) {
    res.status(404).json({ error: "League not found" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const [existing] = await db.select({ id: leagueStaffTable.id })
    .from(leagueStaffTable)
    .where(and(
      eq(leagueStaffTable.leagueId, leagueId),
      eq(leagueStaffTable.email, normalizedEmail),
    ));

  if (existing) {
    res.status(409).json({ error: "This email is already a staff member for this league" });
    return;
  }

  const [matchedUser] = await db.select({ id: appUsersTable.id, displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.email, normalizedEmail));

  const [created] = await db.insert(leagueStaffTable).values({
    leagueId,
    organizationId: league.organizationId,
    userId: matchedUser?.id ?? null,
    email: normalizedEmail,
    displayName: displayName || matchedUser?.displayName || null,
    role: role as "league_admin" | "competition_secretary",
    invitedByUserId: (req.user as { id?: number }).id ?? null,
  }).returning();

  res.status(201).json(created);
});

// DELETE /api/leagues/:leagueId/staff/:staffId — remove a staff member
router.delete("/leagues/:leagueId/staff/:staffId", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const staffId = parseInt(String((req.params as Record<string, string>).staffId));

  await db.delete(leagueStaffTable).where(and(
    eq(leagueStaffTable.id, staffId),
    eq(leagueStaffTable.leagueId, leagueId),
  ));

  res.json({ success: true });
});

export default router;
