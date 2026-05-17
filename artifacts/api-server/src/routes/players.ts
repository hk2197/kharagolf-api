import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { playersTable, scoresTable, waitlistTable, tournamentsTable, withdrawalsTable, userNotificationPrefsTable, tournamentStaffTable, orgMembershipsTable, shotsTable, practiceSessionsTable, appUsersTable, manualEntryAlertsTable } from "@workspace/db";
import { eq, sql, sum, asc, desc, and, inArray, avg, min, max, count } from "drizzle-orm";
import { notifyLeaderboardUpdate } from "../lib/realtime";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { track } from "../lib/analytics";

const router: IRouter = Router({ mergeParams: true });

/** Cast req.user to the typed AuthUser model. Guard with user != null first. */
function getUser(req: Request): AuthUser {
  return req.user as unknown as AuthUser;
}

function verifyAdmin(req: Request, res: Response): boolean {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  const role = req.user ? getUser(req).role : undefined;
  if (!["super_admin", "org_admin", "tournament_director"].includes(role ?? "")) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

/**
 * Verifies the user can modify handicap data for a tournament within the given org.
 * Allows: super_admin, org_admin, tournament_director, committee_member — all must belong to the same org.
 */
async function verifyHandicapAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = getUser(req);
  if (user.role === "super_admin") return true;

  const userOrgId = user.organizationId ?? null;

  // org_admin / tournament_director must belong to this org
  if (["org_admin", "tournament_director"].includes(user.role) && userOrgId === orgId) return true;

  // committee_member must have an org_memberships row in this org with the right role
  if (user.role === "committee_member") {
    const [membership] = await db
      .select({ role: orgMembershipsTable.role })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (membership && ["org_admin", "tournament_director", "committee_member"].includes(membership.role)) return true;
  }

  // Also allow org_admin / tournament_director via org_memberships (cross-org membership scenario)
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (membership && ["org_admin", "tournament_director", "committee_member"].includes(membership.role)) return true;

  res.status(403).json({ error: "Admin access required" });
  return false;
}

async function verifyCheckInAccess(req: Request, res: Response, orgId: number, tournamentId: number): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = getUser(req);
  const userOrgId = user.organizationId ?? null;

  if (user.role === "super_admin") return true;
  if (["org_admin", "tournament_director"].includes(user.role) && userOrgId === orgId) return true;

  // Also allow via org_memberships
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (membership && ["org_admin", "tournament_director"].includes(membership.role)) return true;

  // Check tournament staff: tournament_admin or volunteer may check players in
  const [tStaff] = await db
    .select({ role: tournamentStaffTable.role })
    .from(tournamentStaffTable)
    .where(and(eq(tournamentStaffTable.tournamentId, tournamentId), eq(tournamentStaffTable.userId, user.id)));

  if (tStaff && ["tournament_admin", "volunteer"].includes(tStaff.role)) return true;

  res.status(403).json({ error: "Admin or volunteer access required" });
  return false;
}

// GET /organizations/:orgId/tournaments/:tournamentId/players
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const players = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId))
    .orderBy(playersTable.lastName);

  // Fetch notification prefs for players who have a linked userId
  const userIds = players.map(p => p.userId).filter((id): id is number => id != null);
  const prefsMap = new Map<number, { preferEmail: boolean; preferPush: boolean; preferSms: boolean; preferWhatsapp: boolean; notifySideGameReceipts: boolean }>();
  if (userIds.length > 0) {
    const prefs = await db.select().from(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    for (const pref of prefs) {
      prefsMap.set(pref.userId, { preferEmail: pref.preferEmail, preferPush: pref.preferPush, preferSms: pref.preferSms, preferWhatsapp: pref.preferWhatsapp, notifySideGameReceipts: pref.notifySideGameReceipts });
    }
  }

  // Compute scores for each player
  const enriched = await Promise.all(players.map(async (p) => {
    const scores = await db.select().from(scoresTable).where(eq(scoresTable.playerId, p.id));
    const grossScore = scores.reduce((acc, s) => acc + s.strokes, 0);
    const handicapIndexNum = p.handicapIndex ? Number(p.handicapIndex) : null;
    const handicapOverrideNum = p.handicapOverride != null ? Number(p.handicapOverride) : null;
    const notifPrefs = p.userId ? prefsMap.get(p.userId) ?? null : null;
    return {
      ...p,
      handicapIndex: handicapIndexNum,
      handicapOverride: handicapOverrideNum,
      effectiveHandicap: handicapOverrideNum ?? handicapIndexNum,
      entryFee: null,
      grossScore: scores.length > 0 ? grossScore : null,
      netScore: null,
      scoreToPar: null,
      notifPrefs,
    };
  }));

  res.json(enriched);
});

// POST /organizations/:orgId/tournaments/:tournamentId/players
router.post("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { userId, firstName, lastName, email, phone, handicapIndex, ghinNumber, flight, teeBox, teamName } = req.body;

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }

  const [player] = await db
    .insert(playersTable)
    .values({
      tournamentId,
      userId: userId ?? null,
      firstName,
      lastName,
      email: email ?? null,
      phone: phone ?? null,
      handicapIndex: handicapIndex ? String(handicapIndex) : null,
      ghinNumber: ghinNumber ?? null,
      flight: flight ?? null,
      teeBox: teeBox ?? "white",
      paymentStatus: "unpaid",
      checkedIn: false,
      currentRound: 1,
      teamName: teamName ?? null,
    })
    .returning();

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  dispatchWebhookEvent(orgId, "player.registered", {
    playerId: player.id,
    tournamentId: player.tournamentId,
    firstName: player.firstName,
    lastName: player.lastName,
    email: player.email,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
  });

  // Wave 0 / Task #935 — analytics smoke test (3/5: tournament_registration)
  void track("tournament_registration", {
    tournamentId,
    playerId: player.id,
    hasGhin: Boolean(ghinNumber),
    teeBox: teeBox ?? null,
    flight: flight ?? null,
    teamName: teamName ?? null,
  }, {
    organizationId: parseInt(String((req.params as Record<string, string>).orgId)) || null,
    userId: userId ?? null,
    surface: "api",
  });

  res.status(201).json({ ...player, handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null });
});

// PUT /organizations/:orgId/tournaments/:tournamentId/players/:playerId
router.put("/:playerId", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  // handicapOverride and paymentStatus are admin-only — use dedicated PATCH endpoints
  const { firstName, lastName, email, phone, handicapIndex, ghinNumber, flight, teeBox, teamName, paymentStatus } = req.body;

  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const [player] = await db
    .update(playersTable)
    .set({
      firstName,
      lastName,
      email: email ?? null,
      phone: phone ?? null,
      handicapIndex: handicapIndex !== undefined ? (handicapIndex ? String(handicapIndex) : null) : undefined,
      ghinNumber: ghinNumber ?? null,
      flight: flight ?? null,
      teeBox: teeBox ?? "white",
      teamName: teamName ?? null,
      paymentStatus: paymentStatus ?? "unpaid",
    })
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
    .returning();

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  const effectiveHandicap = player.handicapOverride != null
    ? Number(player.handicapOverride)
    : (player.handicapIndex ? Number(player.handicapIndex) : null);
  res.json({
    ...player,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
    handicapOverride: player.handicapOverride != null ? Number(player.handicapOverride) : null,
    effectiveHandicap,
  });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/players/:playerId/handicap-override — admin sets/clears override
router.patch("/:playerId/handicap-override", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await verifyHandicapAdmin(req, res, orgId)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { handicapOverride } = req.body;

  const [player] = await db
    .update(playersTable)
    .set({ handicapOverride: handicapOverride !== null && handicapOverride !== undefined ? String(handicapOverride) : null })
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
    .returning();

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  dispatchWebhookEvent(orgId, "handicap.updated", {
    playerId: player.id,
    tournamentId: player.tournamentId,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
    handicapOverride: player.handicapOverride != null ? Number(player.handicapOverride) : null,
    effectiveHandicap: player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : null),
  });

  res.json({
    ...player,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
    handicapOverride: player.handicapOverride != null ? Number(player.handicapOverride) : null,
    effectiveHandicap: player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : null),
  });
});

// Shared helper: promote first waitlisted player after a removal
async function promoteFromWaitlist(tournamentId: number) {
  const validTeeBox = ["blue", "white", "red", "gold", "black"] as const;

  const [tournament] = await db
    .select({ maxPlayers: tournamentsTable.maxPlayers })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament?.maxPlayers) return;

  const [nextWaiting] = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(asc(waitlistTable.position))
    .limit(1);

  if (!nextWaiting) return;

  const teeBox = validTeeBox.includes((nextWaiting.teeBox ?? "white") as typeof validTeeBox[number])
    ? ((nextWaiting.teeBox ?? "white") as typeof validTeeBox[number])
    : "white" as const;

  await db.insert(playersTable).values({
    tournamentId,
    userId: null,
    firstName: nextWaiting.firstName,
    lastName: nextWaiting.lastName,
    email: nextWaiting.email,
    phone: nextWaiting.phone ?? null,
    handicapIndex: nextWaiting.handicapIndex ?? null,
    flight: nextWaiting.flight ?? null,
    teeBox,
    paymentStatus: "unpaid",
    checkedIn: false,
    currentRound: 1,
    teamName: null,
  });

  await db
    .update(waitlistTable)
    .set({ promotedAt: new Date() })
    .where(eq(waitlistTable.id, nextWaiting.id));
}

// DELETE /organizations/:orgId/tournaments/:tournamentId/players/:playerId/withdraw
// Withdrawal — logs a withdrawal record with refund tracking, removes player, auto-promotes waitlist
router.delete("/:playerId/withdraw", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const [player] = await db
    .select()
    .from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) {
    res.status(404).json({ error: "Player not found in this tournament" });
    return;
  }

  const [withdrawal] = await db.insert(withdrawalsTable).values({
    tournamentId,
    playerName: `${player.firstName} ${player.lastName}`,
    playerEmail: player.email ?? "",
    phone: player.phone ?? null,
    handicapIndex: player.handicapIndex ?? null,
    flight: player.flight ?? null,
    teeBox: player.teeBox ?? null,
    paymentStatus: player.paymentStatus,
    paymentReference: player.stripePaymentId ?? null,
    refundStatus: player.paymentStatus === "paid" ? "pending" : "not_applicable",
    actorName: req.user?.displayName ?? req.user?.email ?? "Admin",
  }).returning();

  await db.delete(playersTable).where(eq(playersTable.id, playerId));
  await promoteFromWaitlist(tournamentId);
  res.json({ withdrawn: true, autoPromoted: true, withdrawalId: withdrawal.id });
});

// GET /organizations/:orgId/tournaments/:tournamentId/players/withdrawals
// Returns withdrawal records with refund status (admin only)
router.get("/withdrawals", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const records = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.tournamentId, tournamentId))
    .orderBy(withdrawalsTable.withdrawnAt);
  res.json(records);
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/players/withdrawals/:withdrawalId
// Update refund status on a withdrawal record (admin only)
router.patch("/withdrawals/:withdrawalId", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const withdrawalId = parseInt(String((req.params as Record<string, string>).withdrawalId));
  const { refundStatus, refundReference, refundNotes } = req.body;

  const [updated] = await db
    .update(withdrawalsTable)
    .set({ refundStatus, refundReference, refundNotes })
    .where(and(eq(withdrawalsTable.id, withdrawalId), eq(withdrawalsTable.tournamentId, tournamentId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Withdrawal record not found" }); return; } }
  res.json(updated);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/players/:playerId
// Permanently removes the player and auto-promotes waitlisted player (admin only)
router.delete("/:playerId", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const deleted = await db
    .delete(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
    .returning({ id: playersTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Player not found in this tournament" });
    return;
  }
  await promoteFromWaitlist(tournamentId);
  res.status(204).send();
});

// GET /organizations/:orgId/tournaments/:tournamentId/players/waitlist
// Returns only entries that have NOT yet been promoted (active waitlist)
router.get("/waitlist", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const entries = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(asc(waitlistTable.position));

  res.json(entries.map(e => ({
    ...e,
    handicapIndex: e.handicapIndex ? Number(e.handicapIndex) : null,
    promoted: false,
  })));
});

// GET /organizations/:orgId/tournaments/:tournamentId/players/template
router.get("/template", (_req: Request, res: Response) => {
  const header = "firstName,lastName,email,phone,handicapIndex,flight,teeBox";
  const example = "John,Doe,john@example.com,+1234567890,12.5,A,white";
  const example2 = "Jane,Smith,jane@example.com,,8.2,B,gold";
  const csv = [header, example, example2].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"players-template.csv\"");
  res.send(csv);
});

// POST /organizations/:orgId/tournaments/:tournamentId/players/import
router.post("/import", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { csvContent } = req.body;

  if (!csvContent || typeof csvContent !== "string") {
    res.status(400).json({ error: "csvContent is required" });
    return;
  }

  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 2) {
    res.status(400).json({ error: "CSV must have a header row and at least one data row" });
    return;
  }

  const rawHeaders = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const errors: string[] = [];
  const toInsert: Array<typeof playersTable.$inferInsert> = [];

  const teeBoxValues = ["blue", "white", "red", "gold", "black"] as const;

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    // Handle quoted fields
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of rawLine) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { values.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    values.push(current.trim());

    const row: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => { row[h] = values[idx] ?? ""; });

    const firstName = row.firstname || row.first || "";
    const lastName = row.lastname || row.last || "";

    if (!firstName) { errors.push(`Row ${i}: missing firstName`); continue; }
    if (!lastName) { errors.push(`Row ${i}: missing lastName`); continue; }

    const rawTeeBox = (row.teebox || row.tee || "white").toLowerCase();
    const teeBox = teeBoxValues.includes(rawTeeBox as typeof teeBoxValues[number])
      ? (rawTeeBox as typeof teeBoxValues[number])
      : "white" as const;

    const handicap = row.handicapindex || row.handicap || "";

    toInsert.push({
      tournamentId,
      userId: null,
      firstName,
      lastName,
      email: row.email || null,
      phone: row.phone || null,
      handicapIndex: handicap ? String(parseFloat(handicap)) : null,
      ghinNumber: row.ghinnumber || row.ghin || null,
      flight: row.flight || null,
      teeBox,
      paymentStatus: "unpaid",
      checkedIn: false,
      currentRound: 1,
      teamName: null,
    });
  }

  if (toInsert.length === 0) {
    res.status(400).json({ error: "No valid rows found", errors });
    return;
  }

  const inserted = await db.insert(playersTable).values(toInsert).returning();
  res.json({ imported: inserted.length, errors });
});

// POST /organizations/:orgId/tournaments/:tournamentId/players/:playerId/checkin (admin or volunteer)
// tournamentId scoped to prevent cross-tournament mutations
router.post("/:playerId/checkin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await verifyCheckInAccess(req, res, orgId, tournamentId)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const [player] = await db
    .update(playersTable)
    .set({ checkedIn: true, checkedInAt: new Date() })
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
    .returning();

  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  dispatchWebhookEvent(orgId, "player.checked_in", {
    playerId: player.id,
    tournamentId: player.tournamentId,
    firstName: player.firstName,
    lastName: player.lastName,
    checkedInAt: player.checkedInAt?.toISOString(),
  });

  res.json({ ...player, handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null });
});

// POST /organizations/:orgId/tournaments/:tournamentId/players/mark-dns (admin only)
// DNS cutoff: marks all players who have NOT checked in as DNS (Did Not Start)
// Idempotent — safe to call multiple times
router.post("/mark-dns", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const updated = await db
    .update(playersTable)
    .set({ dns: true })
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.checkedIn, false), eq(playersTable.dns, false)))
    .returning({ id: playersTable.id });

  res.json({ markedDns: updated.length, message: `${updated.length} player(s) marked as DNS` });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/players/:playerId/dns (admin only)
// Toggle DNS status for a single player
router.patch("/:playerId/dns", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { dns } = req.body as { dns: boolean };

  const [player] = await db
    .update(playersTable)
    .set({ dns: Boolean(dns) })
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
    .returning();

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  res.json({ ...player, handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null });
});

// ─── SHOT TRACKING ────────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/players/:playerId/rounds/:round/shots
// Returns all shots for a player's round, grouped by hole number
router.get("/:playerId/rounds/:round/shots", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const round = parseInt(String((req.params as Record<string, string>).round));
  if (isNaN(tournamentId) || isNaN(playerId) || isNaN(round)) {
    res.status(400).json({ error: "Invalid params" }); return;
  }

  const shots = await db.select().from(shotsTable)
    .where(and(
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.round, round),
    ))
    .orderBy(asc(shotsTable.holeNumber), asc(shotsTable.shotNumber));

  // Group by hole
  const byHole: Record<number, typeof shots> = {};
  for (const shot of shots) {
    if (!byHole[shot.holeNumber]) byHole[shot.holeNumber] = [];
    byHole[shot.holeNumber].push(shot);
  }

  const holes = Object.entries(byHole).map(([hole, holeShots]) => ({
    holeNumber: parseInt(hole),
    shotCount: holeShots.length,
    shots: holeShots.map(s => ({
      id: s.id,
      shotNumber: s.shotNumber,
      shotType: s.shotType,
      club: s.club,
      latitude: s.latitude ? parseFloat(s.latitude) : null,
      longitude: s.longitude ? parseFloat(s.longitude) : null,
      distanceToPin: s.distanceToPin ? parseFloat(s.distanceToPin) : null,
      distanceCarried: s.distanceCarried ? parseFloat(s.distanceCarried) : null,
      recordedAt: s.recordedAt,
    })),
  })).sort((a, b) => a.holeNumber - b.holeNumber);

  res.json({ tournamentId, playerId, round, holes });
});

// ─── CLUB DISTANCE PROFILE ────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/players/:playerId/club-profile
// Returns aggregated club distance stats from shots recorded for this player in this specific tournament.
router.get("/:playerId/club-profile", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId) || isNaN(orgId) || isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid params" }); return; } }

  // Verify player belongs to this tournament (prevents cross-tenant access)
  const [playerRow] = await db.select({ id: playersTable.id }).from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));
  if (!playerRow) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  const profile = await db.select({
    club: shotsTable.club,
    avgDistance: avg(shotsTable.distanceCarried),
    minDistance: min(shotsTable.distanceCarried),
    maxDistance: max(shotsTable.distanceCarried),
    shotCount: count(shotsTable.id),
  }).from(shotsTable)
    .where(and(eq(shotsTable.playerId, playerId), sql`${shotsTable.club} IS NOT NULL`, sql`${shotsTable.distanceCarried} IS NOT NULL`))
    .groupBy(shotsTable.club)
    .orderBy(desc(avg(shotsTable.distanceCarried)));

  res.json(profile.map(p => ({
    club: p.club,
    avgDistance: p.avgDistance ? parseFloat(p.avgDistance) : null,
    minDistance: p.minDistance ? parseFloat(p.minDistance) : null,
    maxDistance: p.maxDistance ? parseFloat(p.maxDistance) : null,
    shotCount: Number(p.shotCount),
  })));
});

// ─── SHOT SOURCE DATA QUALITY (Task #709) ─────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/players/data-quality
// Admin-only. Returns one row per (player, round) with a breakdown of how many
// shots came from each capture source (watch / phone / scorer / manual), plus
// a `flagged` boolean for rounds that are >50% manual entries. Tournament
// directors use this to spot players whose data is mostly hand-keyed and
// therefore less trustworthy for SG / dispersion analytics.
router.get("/data-quality", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const rows = await db.select({
    playerId: shotsTable.playerId,
    round: shotsTable.round,
    source: shotsTable.source,
    n: count(shotsTable.id),
  })
    .from(shotsTable)
    .innerJoin(playersTable, eq(playersTable.id, shotsTable.playerId))
    .where(eq(playersTable.tournamentId, tournamentId))
    .groupBy(shotsTable.playerId, shotsTable.round, shotsTable.source);

  type Bucket = { watch: number; phone: number; manual: number; scorer: number; total: number };
  const byKey = new Map<string, { playerId: number; round: number; counts: Bucket }>();
  for (const r of rows) {
    if (r.playerId == null || r.round == null) continue;
    const key = `${r.playerId}:${r.round}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { playerId: r.playerId, round: r.round, counts: { watch: 0, phone: 0, manual: 0, scorer: 0, total: 0 } };
      byKey.set(key, entry);
    }
    const src = (r.source ?? "manual") as "watch"|"phone"|"manual"|"scorer";
    const n = Number(r.n);
    entry.counts[src] = n;
    entry.counts.total += n;
  }

  // Hydrate player names so the dashboard doesn't need a second query.
  const playerIds = [...new Set([...byKey.values()].map(v => v.playerId))];
  const playerInfo = playerIds.length
    ? await db.select({
        id: playersTable.id,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      }).from(playersTable).where(inArray(playersTable.id, playerIds))
    : [];
  const nameById = new Map(playerInfo.map(p => [p.id, `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()]));

  // Task #1019 — surface the most recent manual-entry alert per (player, round)
  // so the Players-tab data-quality table can show an "alerted at HH:MM" badge
  // and the recipient/push/email delivery counts for ops debugging.
  // Task #1658 — also pull `status`/`reason` so the badge can distinguish
  // "alerted" from "skipped — org muted" / "skipped — below threshold" /
  // etc. Skip rows are persisted by the notifier alongside the success
  // path, and surfacing the reason here is what closes the support loop:
  // a TD asking "why did this round not produce an alert?" can read the
  // answer right next to the round.
  const alertRows = playerIds.length
    ? await db.select({
        playerId: manualEntryAlertsTable.playerId,
        round: manualEntryAlertsTable.round,
        sentAt: manualEntryAlertsTable.sentAt,
        recipientCount: manualEntryAlertsTable.recipientCount,
        pushAttempted: manualEntryAlertsTable.pushAttempted,
        pushSent: manualEntryAlertsTable.pushSent,
        emailAttempted: manualEntryAlertsTable.emailAttempted,
        emailSent: manualEntryAlertsTable.emailSent,
        status: manualEntryAlertsTable.status,
        reason: manualEntryAlertsTable.reason,
      }).from(manualEntryAlertsTable)
        .where(and(
          eq(manualEntryAlertsTable.tournamentId, tournamentId),
          inArray(manualEntryAlertsTable.playerId, playerIds),
        ))
        .orderBy(asc(manualEntryAlertsTable.sentAt))
    : [];
  const alertByKey = new Map<string, {
    sentAt: Date;
    recipientCount: number;
    pushAttempted: number; pushSent: number;
    emailAttempted: number; emailSent: number;
    status: string;
    reason: string | null;
  }>();
  for (const a of alertRows) {
    // Last write wins → keeps the most recent notify outcome per
    // (player, round). With Task #1658 this is now "the most recent
    // notifier invocation" rather than "the most recent successful
    // alert"; in practice notifier calls are once-per-countersign so
    // there is at most one row per (player, round) and the policy is
    // identical.
    alertByKey.set(`${a.playerId}:${a.round}`, {
      sentAt: a.sentAt,
      recipientCount: a.recipientCount,
      pushAttempted: a.pushAttempted,
      pushSent: a.pushSent,
      emailAttempted: a.emailAttempted,
      emailSent: a.emailSent,
      status: a.status,
      reason: a.reason,
    });
  }

  const result = [...byKey.values()].map(({ playerId, round, counts }) => {
    const manualPct = counts.total > 0 ? counts.manual / counts.total : 0;
    const alert = alertByKey.get(`${playerId}:${round}`) ?? null;
    return {
      playerId,
      playerName: nameById.get(playerId) ?? `Player #${playerId}`,
      round,
      counts: { watch: counts.watch, phone: counts.phone, scorer: counts.scorer, manual: counts.manual },
      total: counts.total,
      manualPct: Math.round(manualPct * 1000) / 10, // one decimal
      flagged: counts.total > 0 && manualPct > 0.5,
      alertedAt: alert ? alert.sentAt.toISOString() : null,
      alertDelivery: alert ? {
        recipientCount: alert.recipientCount,
        pushAttempted: alert.pushAttempted,
        pushSent: alert.pushSent,
        emailAttempted: alert.emailAttempted,
        emailSent: alert.emailSent,
      } : null,
      // Task #1658 — surface the notify outcome so the banner can
      // render "skipped — org muted" instead of leaving the round
      // looking unalerted. `alertStatus` is null for rounds the
      // notifier never ran on (i.e. pre-#1658 rounds with no audit
      // row); the banner treats null the same as the legacy "no
      // badge" case.
      alertStatus: alert ? alert.status : null,
      alertReason: alert ? alert.reason : null,
    };
  }).sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0)
    || b.manualPct - a.manualPct
    || a.playerName.localeCompare(b.playerName)
    || a.round - b.round);

  res.json(result);
});

// ─── PRACTICE SESSIONS ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/players/:playerId/practice
// (also available at /api/practice from portal — see portal.ts)
router.get("/:playerId/practice", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const sessions = await db.select().from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.playerId, playerId))
    .orderBy(desc(practiceSessionsTable.sessionDate))
    .limit(limit);

  res.json(sessions);
});

export default router;
