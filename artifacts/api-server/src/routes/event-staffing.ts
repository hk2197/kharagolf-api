/**
 * Event Day Staffing API — Caddies & Volunteers/Marshals
 *
 * Caddie Roster (org-level):
 *   GET    /organizations/:orgId/caddies                           List caddie roster
 *   POST   /organizations/:orgId/caddies                           Add caddie to roster
 *   PATCH  /organizations/:orgId/caddies/:caddieId                Update caddie
 *   DELETE /organizations/:orgId/caddies/:caddieId                Remove caddie
 *
 * Caddie Assignments (per-tournament):
 *   GET    /organizations/:orgId/tournaments/:tournamentId/caddie-assignments
 *   POST   /organizations/:orgId/tournaments/:tournamentId/caddie-assignments
 *   PATCH  /organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id
 *   DELETE /organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id
 *   POST   /organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id/mark-paid
 *
 * Volunteer Roles (per-tournament):
 *   GET    /organizations/:orgId/tournaments/:tournamentId/volunteer-roles
 *   POST   /organizations/:orgId/tournaments/:tournamentId/volunteer-roles
 *   PATCH  /organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId
 *   DELETE /organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId
 *
 * Volunteer Assignments:
 *   GET    /organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments
 *   POST   /organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments
 *   DELETE /organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments/:id
 *
 * Check-in (QR and manual):
 *   POST   /organizations/:orgId/tournaments/:tournamentId/staff-checkin/qr     QR code scan
 *   POST   /organizations/:orgId/tournaments/:tournamentId/staff-checkin/manual  Manual check-in
 *   POST   /organizations/:orgId/tournaments/:tournamentId/staff-checkin/:id/no-show
 *
 * Staffing Board & Report:
 *   GET    /organizations/:orgId/tournaments/:tournamentId/staffing-board        Live board
 *   GET    /organizations/:orgId/tournaments/:tournamentId/staffing-report       Post-event report
 *
 * Mobile (portal player):
 *   GET    /portal/staffing/my-assignments                                        All assignments for logged-in user
 *   GET    /public/staffing/checkin/:qrToken                                      QR token info (public)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  caddiesTable,
  caddieEventAssignmentsTable,
  volunteerRolesTable,
  volunteerAssignmentsTable,
  staffCheckinsTable,
  tournamentsTable,
  playersTable,
  teeTimesTable,
  appUsersTable,
  organizationsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, and, desc, count, isNull, sql, inArray } from "drizzle-orm";
import { requireOrgAdmin, requireTournamentAccess } from "../lib/permissions";
import { sendPushToUsers, classifyPushDelivery } from "../lib/push";
import { logger } from "../lib/logger";
import crypto from "crypto";

/**
 * Task #1786 — Notification audit key for the volunteer-assignment push.
 * Registered in `lib/notificationRegistry.ts` so the admin notification
 * audit dashboard surfaces failed deliveries alongside every other
 * audit-logged notify path.
 */
const VOLUNTEER_ASSIGNMENT_NOTIFICATION_KEY = "volunteer.assignment.assigned";

const router: IRouter = Router({ mergeParams: true });

function getPortalUserId(req: Request): number | null {
  const u = (req as unknown as { portalUser?: { userId?: number } }).portalUser;
  return u?.userId ? Number(u.userId) : null;
}

// ─── CADDIE ROSTER ───────────────────────────────────────────────────────────

router.get("/organizations/:orgId/caddies", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caddies = await db
    .select()
    .from(caddiesTable)
    .where(eq(caddiesTable.organizationId, orgId))
    .orderBy(caddiesTable.firstName);

  res.json({ caddies });
});

router.post("/organizations/:orgId/caddies", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { firstName, lastName, phone, email, experienceLevel, notes } = req.body as {
    firstName: string;
    lastName: string;
    phone?: string;
    email?: string;
    experienceLevel?: "trainee" | "junior" | "senior" | "master";
    notes?: string;
  };

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required." });
    return;
  }

  const [caddie] = await db
    .insert(caddiesTable)
    .values({ organizationId: orgId, firstName, lastName, phone, email, experienceLevel, notes })
    .returning();

  res.status(201).json({ caddie });
});

router.patch("/organizations/:orgId/caddies/:caddieId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caddieId = parseInt(String((req.params as Record<string, string>).caddieId));
  const { firstName, lastName, phone, email, experienceLevel, notes } = req.body as {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    experienceLevel?: "trainee" | "junior" | "senior" | "master";
    notes?: string;
  };

  const [caddie] = await db
    .update(caddiesTable)
    .set({ firstName, lastName, phone, email, experienceLevel, notes })
    .where(and(eq(caddiesTable.id, caddieId), eq(caddiesTable.organizationId, orgId)))
    .returning();

  if (!caddie) { { res.status(404).json({ error: "Caddie not found." }); return; } }
  res.json({ caddie });
});

router.delete("/organizations/:orgId/caddies/:caddieId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caddieId = parseInt(String((req.params as Record<string, string>).caddieId));
  const [deleted] = await db
    .delete(caddiesTable)
    .where(and(eq(caddiesTable.id, caddieId), eq(caddiesTable.organizationId, orgId)))
    .returning({ id: caddiesTable.id });

  if (!deleted) { { res.status(404).json({ error: "Caddie not found." }); return; } }
  res.json({ success: true });
});

// ─── CADDIE ASSIGNMENTS ───────────────────────────────────────────────────────

router.get("/organizations/:orgId/tournaments/:tournamentId/caddie-assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const assignments = await db
    .select({
      id: caddieEventAssignmentsTable.id,
      caddieId: caddieEventAssignmentsTable.caddieId,
      caddieFirstName: caddiesTable.firstName,
      caddieLastName: caddiesTable.lastName,
      caddiePhone: caddiesTable.phone,
      caddieExperienceLevel: caddiesTable.experienceLevel,
      playerId: caddieEventAssignmentsTable.playerId,
      playerName: caddieEventAssignmentsTable.playerName,
      teeTimeId: caddieEventAssignmentsTable.teeTimeId,
      agreedFee: caddieEventAssignmentsTable.agreedFee,
      feeMode: caddieEventAssignmentsTable.feeMode,
      feePaid: caddieEventAssignmentsTable.feePaid,
      feePaidAt: caddieEventAssignmentsTable.feePaidAt,
      notes: caddieEventAssignmentsTable.notes,
      createdAt: caddieEventAssignmentsTable.createdAt,
    })
    .from(caddieEventAssignmentsTable)
    .innerJoin(caddiesTable, eq(caddiesTable.id, caddieEventAssignmentsTable.caddieId))
    .where(
      and(
        eq(caddieEventAssignmentsTable.tournamentId, tournamentId),
        eq(caddieEventAssignmentsTable.organizationId, orgId),
      )
    )
    .orderBy(caddiesTable.firstName);

  // Attach check-in status
  const checkins = await db
    .select({ caddieAssignmentId: staffCheckinsTable.caddieAssignmentId })
    .from(staffCheckinsTable)
    .where(
      and(
        eq(staffCheckinsTable.tournamentId, tournamentId),
        eq(staffCheckinsTable.checkinType, "caddie"),
      )
    );

  const checkedInIds = new Set(checkins.map(c => c.caddieAssignmentId));

  res.json({
    assignments: assignments.map(a => ({
      ...a,
      checkedIn: checkedInIds.has(a.id),
    })),
  });
});

router.post("/organizations/:orgId/tournaments/:tournamentId/caddie-assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const { caddieId, playerId, playerName, teeTimeId, agreedFee, feeMode, notes } = req.body as {
    caddieId: number;
    playerId?: number;
    playerName?: string;
    teeTimeId?: number;
    agreedFee?: string;
    feeMode?: "cash" | "account";
    notes?: string;
  };

  if (!caddieId) { { res.status(400).json({ error: "caddieId is required." }); return; } }

  const [assignment] = await db
    .insert(caddieEventAssignmentsTable)
    .values({
      caddieId,
      tournamentId,
      organizationId: orgId,
      playerId: playerId ?? null,
      playerName: playerName ?? null,
      teeTimeId: teeTimeId ?? null,
      agreedFee: agreedFee ?? null,
      feeMode: feeMode ?? "cash",
      notes: notes ?? null,
    })
    .returning();

  // Send push notification to caddie if they have a user account
  try {
    const [caddie] = await db
      .select({ firstName: caddiesTable.firstName, lastName: caddiesTable.lastName })
      .from(caddiesTable)
      .where(eq(caddiesTable.id, caddieId));

    const [tournament] = await db
      .select({ name: tournamentsTable.name })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));

    if (caddie && tournament) {
      logger.info({ caddieId, tournamentId }, "Caddie assignment created — notification skipped (no linked user account)");
    }
  } catch (err) {
    logger.warn({ err }, "Caddie assignment notification failed");
  }

  res.status(201).json({ assignment });
});

router.patch("/organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const { playerId, playerName, teeTimeId, agreedFee, feeMode, notes } = req.body as {
    playerId?: number | null;
    playerName?: string;
    teeTimeId?: number | null;
    agreedFee?: string;
    feeMode?: "cash" | "account";
    notes?: string;
  };

  const [assignment] = await db
    .update(caddieEventAssignmentsTable)
    .set({ playerId, playerName, teeTimeId, agreedFee, feeMode, notes, updatedAt: new Date() })
    .where(and(eq(caddieEventAssignmentsTable.id, id), eq(caddieEventAssignmentsTable.tournamentId, tournamentId)))
    .returning();

  if (!assignment) { { res.status(404).json({ error: "Assignment not found." }); return; } }
  res.json({ assignment });
});

router.delete("/organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [deleted] = await db
    .delete(caddieEventAssignmentsTable)
    .where(and(eq(caddieEventAssignmentsTable.id, id), eq(caddieEventAssignmentsTable.tournamentId, tournamentId)))
    .returning({ id: caddieEventAssignmentsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Assignment not found." }); return; } }
  res.json({ success: true });
});

router.post("/organizations/:orgId/tournaments/:tournamentId/caddie-assignments/:id/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [assignment] = await db
    .update(caddieEventAssignmentsTable)
    .set({ feePaid: true, feePaidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(caddieEventAssignmentsTable.id, id), eq(caddieEventAssignmentsTable.tournamentId, tournamentId)))
    .returning();

  if (!assignment) { { res.status(404).json({ error: "Assignment not found." }); return; } }
  res.json({ assignment });
});

// ─── VOLUNTEER ROLES ─────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const roles = await db
    .select()
    .from(volunteerRolesTable)
    .where(
      and(
        eq(volunteerRolesTable.tournamentId, tournamentId),
        eq(volunteerRolesTable.organizationId, orgId),
      )
    )
    .orderBy(volunteerRolesTable.title);

  // Count assignments per role
  const assignmentCounts = await db
    .select({
      roleId: volunteerAssignmentsTable.roleId,
      cnt: count(volunteerAssignmentsTable.id),
    })
    .from(volunteerAssignmentsTable)
    .where(eq(volunteerAssignmentsTable.tournamentId, tournamentId))
    .groupBy(volunteerAssignmentsTable.roleId);

  const countMap = new Map(assignmentCounts.map(a => [a.roleId, Number(a.cnt)]));

  // Get check-in counts per role
  const checkinCounts = await db
    .select({
      volunteerAssignmentId: staffCheckinsTable.volunteerAssignmentId,
    })
    .from(staffCheckinsTable)
    .where(
      and(
        eq(staffCheckinsTable.tournamentId, tournamentId),
        eq(staffCheckinsTable.checkinType, "volunteer"),
      )
    );

  const volunteerAssignmentIds = new Set(checkinCounts.map(c => c.volunteerAssignmentId));

  const assignments = await db
    .select({ id: volunteerAssignmentsTable.id, roleId: volunteerAssignmentsTable.roleId })
    .from(volunteerAssignmentsTable)
    .where(eq(volunteerAssignmentsTable.tournamentId, tournamentId));

  const checkinByRole = new Map<number, number>();
  for (const a of assignments) {
    if (volunteerAssignmentIds.has(a.id)) {
      checkinByRole.set(a.roleId, (checkinByRole.get(a.roleId) ?? 0) + 1);
    }
  }

  res.json({
    roles: roles.map(r => ({
      ...r,
      assignedCount: countMap.get(r.id) ?? 0,
      checkedInCount: checkinByRole.get(r.id) ?? 0,
    })),
  });
});

router.post("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const { roleType, title, description, location, maxVolunteers } = req.body as {
    roleType?: "starter" | "marshal" | "scorer" | "registration" | "first_aid" | "transport" | "other";
    title: string;
    description?: string;
    location?: string;
    maxVolunteers?: number;
  };

  if (!title) { { res.status(400).json({ error: "title is required." }); return; } }

  const qrToken = crypto.randomBytes(16).toString("hex");

  const [role] = await db
    .insert(volunteerRolesTable)
    .values({
      tournamentId,
      organizationId: orgId,
      roleType: roleType ?? "other",
      title,
      description: description ?? null,
      location: location ?? null,
      maxVolunteers: maxVolunteers ?? 1,
      qrToken,
    })
    .returning();

  res.status(201).json({ role });
});

router.patch("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const roleId = parseInt(String((req.params as Record<string, string>).roleId));
  const { roleType, title, description, location, maxVolunteers } = req.body as {
    roleType?: "starter" | "marshal" | "scorer" | "registration" | "first_aid" | "transport" | "other";
    title?: string;
    description?: string;
    location?: string;
    maxVolunteers?: number;
  };

  const [role] = await db
    .update(volunteerRolesTable)
    .set({ roleType, title, description, location, maxVolunteers })
    .where(and(eq(volunteerRolesTable.id, roleId), eq(volunteerRolesTable.tournamentId, tournamentId)))
    .returning();

  if (!role) { { res.status(404).json({ error: "Role not found." }); return; } }
  res.json({ role });
});

router.delete("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const roleId = parseInt(String((req.params as Record<string, string>).roleId));
  const [deleted] = await db
    .delete(volunteerRolesTable)
    .where(and(eq(volunteerRolesTable.id, roleId), eq(volunteerRolesTable.tournamentId, tournamentId)))
    .returning({ id: volunteerRolesTable.id });

  if (!deleted) { { res.status(404).json({ error: "Role not found." }); return; } }
  res.json({ success: true });
});

// ─── VOLUNTEER ASSIGNMENTS ────────────────────────────────────────────────────

router.get("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const roleId = parseInt(String((req.params as Record<string, string>).roleId));

  const assignments = await db
    .select()
    .from(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.roleId, roleId), eq(volunteerAssignmentsTable.tournamentId, tournamentId)))
    .orderBy(volunteerAssignmentsTable.firstName);

  const checkins = await db
    .select({ volunteerAssignmentId: staffCheckinsTable.volunteerAssignmentId })
    .from(staffCheckinsTable)
    .where(
      and(
        eq(staffCheckinsTable.tournamentId, tournamentId),
        eq(staffCheckinsTable.checkinType, "volunteer"),
      )
    );

  const checkedInIds = new Set(checkins.map(c => c.volunteerAssignmentId));

  res.json({
    assignments: assignments.map(a => ({
      ...a,
      checkedIn: checkedInIds.has(a.id),
    })),
  });
});

router.post("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const roleId = parseInt(String((req.params as Record<string, string>).roleId));

  const [role] = await db
    .select()
    .from(volunteerRolesTable)
    .where(and(eq(volunteerRolesTable.id, roleId), eq(volunteerRolesTable.tournamentId, tournamentId)));

  if (!role) { { res.status(404).json({ error: "Role not found." }); return; } }

  const existingCount = await db
    .select({ cnt: count(volunteerAssignmentsTable.id) })
    .from(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.roleId, roleId)));

  if (Number(existingCount[0].cnt) >= role.maxVolunteers) {
    res.status(400).json({ error: `This role is already full (max ${role.maxVolunteers}).` });
    return;
  }

  const { userId, firstName, lastName, email, phone, notes } = req.body as {
    userId?: number;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    notes?: string;
  };

  if (!firstName || !lastName) { { res.status(400).json({ error: "firstName and lastName are required." }); return; } }

  const [assignment] = await db
    .insert(volunteerAssignmentsTable)
    .values({
      roleId,
      organizationId: orgId,
      tournamentId,
      userId: userId ?? null,
      firstName,
      lastName,
      email: email ?? null,
      phone: phone ?? null,
      notes: notes ?? null,
    })
    .returning();

  // Push notification to user if linked.
  // Task #1786 — classify the delivery result via `classifyPushDelivery`
  // (the canonical sent/failed/no_address mapping shared with every
  // other notify path, see Task #1070) and write a row in
  // `notification_audit_log` whenever Expo or our HTTP layer rejected
  // the send. Without this audit row, an Expo outage during a busy
  // assignment window would silently lose every "you've been assigned"
  // push and operators would have no surface to reconcile against.
  // `no_address` (no Expo token / non-Expo token) is intentionally NOT
  // audited as a failure — the same rule every other dispatch site
  // follows.
  if (userId) {
    try {
      const [tournament] = await db
        .select({ name: tournamentsTable.name })
        .from(tournamentsTable)
        .where(eq(tournamentsTable.id, tournamentId));

      if (tournament) {
        const pushPayload = { type: "volunteer_assignment" as const, tournamentId, roleId };
        const result = await sendPushToUsers(
          [userId],
          "Volunteer Assignment",
          `You've been assigned as ${role.title} for ${tournament.name}.`,
          pushPayload,
        );
        const status = classifyPushDelivery(result);
        if (status === "failed") {
          try {
            await db.insert(notificationAuditLogTable).values({
              notificationKey: VOLUNTEER_ASSIGNMENT_NOTIFICATION_KEY,
              userId,
              channel: "push",
              status: "failed",
              reason: "push_provider_failed",
              payload: {
                organizationId: orgId,
                tournamentId,
                roleId,
                roleTitle: role.title,
                attempted: result.attempted,
                sent: result.sent,
                failed: result.failed,
                invalid: result.invalid,
              },
            });
          } catch (auditErr) {
            logger.warn({ err: auditErr, userId, tournamentId, roleId }, "Volunteer assignment audit insert failed");
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "Volunteer assignment push notification failed");
      // Task #1786 — even an exception thrown out of `sendPushToUsers`
      // (network blow-up, DB lookup throw) should leave a paper trail.
      try {
        await db.insert(notificationAuditLogTable).values({
          notificationKey: VOLUNTEER_ASSIGNMENT_NOTIFICATION_KEY,
          userId,
          channel: "push",
          status: "failed",
          reason: "push_threw",
          payload: {
            organizationId: orgId,
            tournamentId,
            roleId,
            roleTitle: role.title,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, userId, tournamentId, roleId }, "Volunteer assignment audit insert failed");
      }
    }
  }

  res.status(201).json({ assignment });
});

router.delete("/organizations/:orgId/tournaments/:tournamentId/volunteer-roles/:roleId/assignments/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const roleId = parseInt(String((req.params as Record<string, string>).roleId));
  const [deleted] = await db
    .delete(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.id, id), eq(volunteerAssignmentsTable.roleId, roleId)))
    .returning({ id: volunteerAssignmentsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Assignment not found." }); return; } }
  res.json({ success: true });
});

// ─── CHECK-IN (QR & MANUAL) ───────────────────────────────────────────────────

// Public endpoint: get info about a QR token (for the mobile QR scan flow)
router.get("/public/staffing/checkin/:qrToken", async (req: Request, res: Response) => {
  const { qrToken } = (req.params as Record<string, string>);

  const [role] = await db
    .select({
      id: volunteerRolesTable.id,
      title: volunteerRolesTable.title,
      location: volunteerRolesTable.location,
      roleType: volunteerRolesTable.roleType,
      tournamentId: volunteerRolesTable.tournamentId,
      organizationId: volunteerRolesTable.organizationId,
    })
    .from(volunteerRolesTable)
    .where(eq(volunteerRolesTable.qrToken, qrToken));

  if (!role) { { res.status(404).json({ error: "QR token not found or expired." }); return; } }

  const [tournament] = await db
    .select({ name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, role.tournamentId));

  res.json({ role, tournamentName: tournament?.name });
});

// QR check-in: supply qrToken + volunteerAssignmentId
router.post("/organizations/:orgId/tournaments/:tournamentId/staff-checkin/qr", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const { qrToken, volunteerAssignmentId } = req.body as {
    qrToken: string;
    volunteerAssignmentId: number;
  };

  if (!qrToken || !volunteerAssignmentId) {
    res.status(400).json({ error: "qrToken and volunteerAssignmentId are required." });
    return;
  }

  const [role] = await db
    .select()
    .from(volunteerRolesTable)
    .where(and(eq(volunteerRolesTable.qrToken, qrToken), eq(volunteerRolesTable.tournamentId, tournamentId)));

  if (!role) { { res.status(404).json({ error: "QR token not valid for this tournament." }); return; } }

  const [assignment] = await db
    .select()
    .from(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.id, volunteerAssignmentId), eq(volunteerAssignmentsTable.roleId, role.id)));

  if (!assignment) { { res.status(404).json({ error: "Volunteer assignment not found for this role." }); return; } }

  const userId = (req as unknown as { user?: { id?: number } }).user?.id;

  const [checkin] = await db
    .insert(staffCheckinsTable)
    .values({
      organizationId: orgId,
      tournamentId,
      checkinType: "volunteer",
      volunteerAssignmentId: assignment.id,
      checkedInByUserId: userId ?? null,
      method: "qr",
    })
    .onConflictDoNothing()
    .returning();

  res.json({ checkin: checkin ?? null, alreadyCheckedIn: !checkin });
});

// Manual check-in for caddie or volunteer
router.post("/organizations/:orgId/tournaments/:tournamentId/staff-checkin/manual", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const { checkinType, caddieAssignmentId, volunteerAssignmentId } = req.body as {
    checkinType: "caddie" | "volunteer";
    caddieAssignmentId?: number;
    volunteerAssignmentId?: number;
  };

  if (!checkinType) { { res.status(400).json({ error: "checkinType is required." }); return; } }
  if (checkinType === "caddie" && !caddieAssignmentId) {
    res.status(400).json({ error: "caddieAssignmentId required for caddie check-in." });
    return;
  }
  if (checkinType === "volunteer" && !volunteerAssignmentId) {
    res.status(400).json({ error: "volunteerAssignmentId required for volunteer check-in." });
    return;
  }

  const userId = (req as unknown as { user?: { id?: number } }).user?.id;

  const [checkin] = await db
    .insert(staffCheckinsTable)
    .values({
      organizationId: orgId,
      tournamentId,
      checkinType,
      caddieAssignmentId: caddieAssignmentId ?? null,
      volunteerAssignmentId: volunteerAssignmentId ?? null,
      checkedInByUserId: userId ?? null,
      method: "manual",
    })
    .returning();

  res.json({ checkin });
});

// Mark a person as no-show
router.post("/organizations/:orgId/tournaments/:tournamentId/staff-checkin/:checkinId/no-show", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const checkinId = parseInt(String((req.params as Record<string, string>).checkinId));
  const [updated] = await db
    .update(staffCheckinsTable)
    .set({ noShow: true, noShowMarkedAt: new Date() })
    .where(and(eq(staffCheckinsTable.id, checkinId), eq(staffCheckinsTable.tournamentId, tournamentId)))
    .returning();

  if (!updated) { { res.status(404).json({ error: "Check-in record not found." }); return; } }
  res.json({ checkin: updated });
});

// ─── STAFFING BOARD (LIVE) ────────────────────────────────────────────────────

router.get("/organizations/:orgId/tournaments/:tournamentId/staffing-board", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  // Caddie assignments with check-in status
  const caddieRows = await db
    .select({
      id: caddieEventAssignmentsTable.id,
      caddieId: caddieEventAssignmentsTable.caddieId,
      caddieFirstName: caddiesTable.firstName,
      caddieLastName: caddiesTable.lastName,
      caddieExperienceLevel: caddiesTable.experienceLevel,
      playerName: caddieEventAssignmentsTable.playerName,
      agreedFee: caddieEventAssignmentsTable.agreedFee,
      feeMode: caddieEventAssignmentsTable.feeMode,
      feePaid: caddieEventAssignmentsTable.feePaid,
    })
    .from(caddieEventAssignmentsTable)
    .innerJoin(caddiesTable, eq(caddiesTable.id, caddieEventAssignmentsTable.caddieId))
    .where(and(eq(caddieEventAssignmentsTable.tournamentId, tournamentId), eq(caddieEventAssignmentsTable.organizationId, orgId)));

  const caddieCheckins = await db
    .select({ caddieAssignmentId: staffCheckinsTable.caddieAssignmentId, noShow: staffCheckinsTable.noShow, checkedInAt: staffCheckinsTable.checkedInAt })
    .from(staffCheckinsTable)
    .where(and(eq(staffCheckinsTable.tournamentId, tournamentId), eq(staffCheckinsTable.checkinType, "caddie")));

  const caddieCheckinMap = new Map(caddieCheckins.map(c => [c.caddieAssignmentId, c]));

  // Volunteer roles + assignments
  const volunteerRoles = await db
    .select()
    .from(volunteerRolesTable)
    .where(and(eq(volunteerRolesTable.tournamentId, tournamentId), eq(volunteerRolesTable.organizationId, orgId)))
    .orderBy(volunteerRolesTable.title);

  const volunteerAssignments = await db
    .select()
    .from(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.tournamentId, tournamentId), eq(volunteerAssignmentsTable.organizationId, orgId)));

  const volunteerCheckins = await db
    .select({ volunteerAssignmentId: staffCheckinsTable.volunteerAssignmentId, noShow: staffCheckinsTable.noShow, checkedInAt: staffCheckinsTable.checkedInAt })
    .from(staffCheckinsTable)
    .where(and(eq(staffCheckinsTable.tournamentId, tournamentId), eq(staffCheckinsTable.checkinType, "volunteer")));

  const volunteerCheckinMap = new Map(volunteerCheckins.map(c => [c.volunteerAssignmentId, c]));

  const volunteerAssignmentsByRole = new Map<number, typeof volunteerAssignments>();
  for (const a of volunteerAssignments) {
    if (!volunteerAssignmentsByRole.has(a.roleId)) volunteerAssignmentsByRole.set(a.roleId, []);
    volunteerAssignmentsByRole.get(a.roleId)!.push(a);
  }

  res.json({
    caddies: caddieRows.map(c => ({
      ...c,
      checkedIn: caddieCheckinMap.has(c.id),
      noShow: caddieCheckinMap.get(c.id)?.noShow ?? false,
      checkedInAt: caddieCheckinMap.get(c.id)?.checkedInAt ?? null,
    })),
    volunteerRoles: volunteerRoles.map(role => ({
      ...role,
      assignments: (volunteerAssignmentsByRole.get(role.id) ?? []).map(a => ({
        ...a,
        checkedIn: volunteerCheckinMap.has(a.id),
        noShow: volunteerCheckinMap.get(a.id)?.noShow ?? false,
        checkedInAt: volunteerCheckinMap.get(a.id)?.checkedInAt ?? null,
      })),
    })),
  });
});

// ─── STAFFING REPORT (POST-EVENT) ────────────────────────────────────────────

router.get("/organizations/:orgId/tournaments/:tournamentId/staffing-report", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .select({ name: tournamentsTable.name, startDate: tournamentsTable.startDate })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  // Caddie summary
  const caddieAssignments = await db
    .select({
      id: caddieEventAssignmentsTable.id,
      caddieFirstName: caddiesTable.firstName,
      caddieLastName: caddiesTable.lastName,
      playerName: caddieEventAssignmentsTable.playerName,
      agreedFee: caddieEventAssignmentsTable.agreedFee,
      feeMode: caddieEventAssignmentsTable.feeMode,
      feePaid: caddieEventAssignmentsTable.feePaid,
    })
    .from(caddieEventAssignmentsTable)
    .innerJoin(caddiesTable, eq(caddiesTable.id, caddieEventAssignmentsTable.caddieId))
    .where(and(eq(caddieEventAssignmentsTable.tournamentId, tournamentId), eq(caddieEventAssignmentsTable.organizationId, orgId)));

  const caddieCheckins = await db
    .select({ caddieAssignmentId: staffCheckinsTable.caddieAssignmentId, noShow: staffCheckinsTable.noShow })
    .from(staffCheckinsTable)
    .where(and(eq(staffCheckinsTable.tournamentId, tournamentId), eq(staffCheckinsTable.checkinType, "caddie")));

  const caddieCheckinMap = new Map(caddieCheckins.map(c => [c.caddieAssignmentId, c]));

  // Volunteer summary
  const roles = await db
    .select()
    .from(volunteerRolesTable)
    .where(and(eq(volunteerRolesTable.tournamentId, tournamentId), eq(volunteerRolesTable.organizationId, orgId)));

  const allVolunteerAssignments = await db
    .select()
    .from(volunteerAssignmentsTable)
    .where(and(eq(volunteerAssignmentsTable.tournamentId, tournamentId), eq(volunteerAssignmentsTable.organizationId, orgId)));

  const volunteerCheckins = await db
    .select({ volunteerAssignmentId: staffCheckinsTable.volunteerAssignmentId, noShow: staffCheckinsTable.noShow })
    .from(staffCheckinsTable)
    .where(and(eq(staffCheckinsTable.tournamentId, tournamentId), eq(staffCheckinsTable.checkinType, "volunteer")));

  const volunteerCheckinMap = new Map(volunteerCheckins.map(c => [c.volunteerAssignmentId, c]));

  const caddieReport = caddieAssignments.map(c => ({
    ...c,
    checkedIn: caddieCheckinMap.has(c.id),
    noShow: caddieCheckinMap.get(c.id)?.noShow ?? false,
  }));

  const volunteerReport = roles.map(role => {
    const assignments = allVolunteerAssignments.filter(a => a.roleId === role.id).map(a => ({
      ...a,
      checkedIn: volunteerCheckinMap.has(a.id),
      noShow: volunteerCheckinMap.get(a.id)?.noShow ?? false,
    }));
    return {
      role,
      assignments,
      filled: assignments.length,
      capacity: role.maxVolunteers,
      checkedIn: assignments.filter(a => a.checkedIn && !a.noShow).length,
      noShows: assignments.filter(a => a.noShow).length,
    };
  });

  res.json({
    tournament,
    summary: {
      caddiesAssigned: caddieAssignments.length,
      caddiesCheckedIn: caddieReport.filter(c => c.checkedIn && !c.noShow).length,
      caddieNoShows: caddieReport.filter(c => c.noShow).length,
      volunteerRolesTotal: roles.length,
      volunteersAssigned: allVolunteerAssignments.length,
      volunteersCheckedIn: volunteerReport.reduce((acc, r) => acc + r.checkedIn, 0),
      volunteerNoShows: volunteerReport.reduce((acc, r) => acc + r.noShows, 0),
    },
    caddies: caddieReport,
    volunteers: volunteerReport,
  });
});

// ─── PORTAL (Mobile — player sees their own assignments) ─────────────────────

router.get("/portal/staffing/my-assignments", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required." }); return; } }

  // Volunteer assignments linked to this user
  const volunteerAssignments = await db
    .select({
      id: volunteerAssignmentsTable.id,
      roleId: volunteerAssignmentsTable.roleId,
      tournamentId: volunteerAssignmentsTable.tournamentId,
      roleTitle: volunteerRolesTable.title,
      roleType: volunteerRolesTable.roleType,
      roleLocation: volunteerRolesTable.location,
      qrToken: volunteerRolesTable.qrToken,
      tournamentName: tournamentsTable.name,
      tournamentStartDate: tournamentsTable.startDate,
    })
    .from(volunteerAssignmentsTable)
    .innerJoin(volunteerRolesTable, eq(volunteerRolesTable.id, volunteerAssignmentsTable.roleId))
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, volunteerAssignmentsTable.tournamentId))
    .where(eq(volunteerAssignmentsTable.userId, userId))
    .orderBy(desc(tournamentsTable.startDate));

  // Attach check-in status — look up checkins by the assignment IDs belonging to this user
  const assignmentIds = volunteerAssignments.map(a => a.id);
  const checkedIds = new Set<number | null>();
  if (assignmentIds.length > 0) {
    const checkins = await db
      .select({ volunteerAssignmentId: staffCheckinsTable.volunteerAssignmentId })
      .from(staffCheckinsTable)
      .where(
        and(
          eq(staffCheckinsTable.checkinType, "volunteer"),
          inArray(staffCheckinsTable.volunteerAssignmentId, assignmentIds),
        )
      );
    for (const c of checkins) checkedIds.add(c.volunteerAssignmentId);
  }

  res.json({
    volunteerAssignments: volunteerAssignments.map(a => ({
      ...a,
      checkedIn: checkedIds.has(a.id),
    })),
  });
});

export default router;
