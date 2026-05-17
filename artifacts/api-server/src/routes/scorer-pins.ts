import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "@workspace/api-zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "@workspace/db";
import { scorerPinsTable, tournamentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireTournamentAccess } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/tournaments/:tournamentId/scorer-pins
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const creds = await db
    .select({
      id: scorerPinsTable.id,
      tournamentId: scorerPinsTable.tournamentId,
      label: scorerPinsTable.label,
      expiresAt: scorerPinsTable.expiresAt,
      isRevoked: scorerPinsTable.isRevoked,
      createdByUserId: scorerPinsTable.createdByUserId,
      createdAt: scorerPinsTable.createdAt,
    })
    .from(scorerPinsTable)
    .where(eq(scorerPinsTable.tournamentId, tournamentId));

  res.json(creds);
});

// POST /organizations/:orgId/tournaments/:tournamentId/scorer-pins
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .select({ startDate: tournamentsTable.startDate, endDate: tournamentsTable.endDate, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const { label, expiresAt } = req.body;

  // Default expiry: tournament end date or 24h from now if no end date
  let expiry: Date;
  if (expiresAt) {
    expiry = new Date(expiresAt);
  } else if (tournament.endDate) {
    expiry = new Date(tournament.endDate);
    expiry.setHours(23, 59, 59, 999);
  } else {
    expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  // Generate a random 6-char uppercase hex PIN
  const rawPin = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  const pinHash = await bcrypt.hash(rawPin, 10);

  const [cred] = await db
    .insert(scorerPinsTable)
    .values({
      tournamentId,
      organizationId: tournament.organizationId,
      pin: pinHash,
      label: label ?? "Scorer",
      createdByUserId: req.user ? (req.user as unknown as AuthUser).id : null,
      expiresAt: expiry,
      isRevoked: false,
    })
    .returning();

  // Return the credential with the raw PIN (only shown once)
  res.status(201).json({ ...cred, pin: rawPin });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/scorer-pins/:pinId
// Revokes (soft-deletes) the scorer credential
router.delete("/:pinId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const pinId = parseInt(String((req.params as Record<string, string>).pinId));

  // requireTournamentAccess verifies tournament belongs to org before granting access
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [updated] = await db
    .update(scorerPinsTable)
    .set({ isRevoked: true })
    .where(and(eq(scorerPinsTable.id, pinId), eq(scorerPinsTable.tournamentId, tournamentId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Scorer credential not found" }); return; } }
  res.json({ success: true, revoked: true, id: updated.id });
});

export default router;
