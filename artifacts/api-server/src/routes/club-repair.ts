/**
 * Club Repair & Fitting Tracker — Task #99
 *
 * Endpoints:
 *   POST   /organizations/:orgId/repair-jobs              Create repair job
 *   GET    /organizations/:orgId/repair-jobs              List repair jobs (admin)
 *   GET    /organizations/:orgId/repair-jobs/:jobId       Get single repair job
 *   PATCH  /organizations/:orgId/repair-jobs/:jobId       Update repair job (status, technician, etc.)
 *   DELETE /organizations/:orgId/repair-jobs/:jobId       Delete repair job
 *   GET    /organizations/:orgId/repair-jobs/member/me    Member's own repair jobs
 *
 *   POST   /organizations/:orgId/fitting-sessions         Create fitting session
 *   GET    /organizations/:orgId/fitting-sessions         List fitting sessions (admin)
 *   GET    /organizations/:orgId/fitting-sessions/:id     Get single fitting session
 *   PATCH  /organizations/:orgId/fitting-sessions/:id     Update fitting session
 *   DELETE /organizations/:orgId/fitting-sessions/:id     Delete fitting session
 *   GET    /organizations/:orgId/fitting-sessions/member/me  Member's own fitting sessions
 */

import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  repairJobsTable,
  fittingSessionsTable,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, and, desc, or, inArray } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push";
import { sendBroadcastEmail } from "../lib/mailer";

const router = Router({ mergeParams: true });

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.user) { res.status(401).json({ error: "Unauthenticated" }); return false; }
  const [user] = await db.select({ role: appUsersTable.role, orgId: appUsersTable.organizationId })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user.id));
  if (!user) { res.status(401).json({ error: "User not found" }); return false; }
  if (user.orgId !== orgId) { res.status(403).json({ error: "Forbidden" }); return false; }
  const adminRoles = ["org_admin", "tournament_director", "committee_member", "competition_secretary", "pro_shop", "super_admin"];
  if (!adminRoles.includes(user.role)) { res.status(403).json({ error: "Insufficient permissions" }); return false; }
  return true;
}

async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<{ userId: number; dbUserId: number } | null> {
  if (!req.user) { res.status(401).json({ error: "Unauthenticated" }); return null; }
  const [user] = await db.select({ role: appUsersTable.role, orgId: appUsersTable.organizationId })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user.id));
  if (!user || user.orgId !== orgId) { res.status(403).json({ error: "Forbidden" }); return null; }
  return { userId: req.user.id, dbUserId: req.user.id };
}

// ─── Notification helper ──────────────────────────────────────────────────────

async function notifyMemberReady(job: typeof repairJobsTable.$inferSelect, org: { name: string; logoUrl: string | null; primaryColor: string | null }) {
  if (job.memberId) {
    // Task #1240 — fire-and-forget; PushDeliveryResult is discarded
    // (the helper's caller wraps invocations in try/catch but never
    // branches on `failed`/`sent`/`invalid` counters), classifier
    // intentionally not consulted. Email + admin "ready" status are
    // the durable signals to the member.
    await sendPushToUsers(
      [job.memberId],
      "Clubs Ready for Pickup!",
      `Your repair job at ${org.name} is ready to collect.`,
      { repairJobId: job.id },
    );
  }
  if (job.memberEmail) {
    await sendBroadcastEmail(
      job.memberEmail,
      job.memberName,
      "Your clubs are ready for pickup",
      `Great news!\n\nYour club repair job (${job.description}) at ${org.name} is now ready for pickup.\n\nPlease visit the pro shop at your earliest convenience to collect your clubs.\n\n— The ${org.name} Pro Shop Team`,
      org.name,
      { logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined, orgName: org.name },
    );
  }
}

// ─── Repair Jobs ──────────────────────────────────────────────────────────────

/* POST /organizations/:orgId/repair-jobs */
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { memberName, memberEmail, memberId, jobType, description, technicianId, technicianName, expectedCompletionDate, notes } = req.body;
  if (!memberName || !description) {
    res.status(400).json({ error: "memberName and description are required" });
    return;
  }

  const [job] = await db.insert(repairJobsTable).values({
    organizationId: orgId,
    memberName,
    memberEmail: memberEmail ?? null,
    memberId: memberId ? parseInt(memberId) : null,
    jobType: jobType ?? "other",
    description,
    status: "received",
    technicianId: technicianId ? parseInt(technicianId) : null,
    technicianName: technicianName ?? null,
    expectedCompletionDate: expectedCompletionDate ? new Date(expectedCompletionDate) : null,
    notes: notes ?? null,
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(formatJob(job));
});

/* GET /organizations/:orgId/repair-jobs */
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, technicianId } = req.query as { status?: string; technicianId?: string };

  const conditions = [eq(repairJobsTable.organizationId, orgId)];
  if (status && ["received", "in_progress", "ready_for_pickup", "collected"].includes(status)) {
    conditions.push(eq(repairJobsTable.status, status as any));
  }
  if (technicianId) {
    conditions.push(eq(repairJobsTable.technicianId, parseInt(technicianId)));
  }

  const jobs = await db.select().from(repairJobsTable)
    .where(and(...conditions))
    .orderBy(desc(repairJobsTable.createdAt));

  res.json(jobs.map(formatJob));
});

/* GET /organizations/:orgId/repair-jobs/member/me */
router.get("/member/me", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;

  const jobs = await db.select().from(repairJobsTable)
    .where(and(
      eq(repairJobsTable.organizationId, orgId),
      eq(repairJobsTable.memberId, member.dbUserId),
    ))
    .orderBy(desc(repairJobsTable.createdAt));

  res.json(jobs.map(formatJob));
});

/* GET /organizations/:orgId/repair-jobs/:jobId */
router.get("/:jobId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const jobId = parseInt(String((req.params as Record<string, string>).jobId));

  if (!req.user) { { res.status(401).json({ error: "Unauthenticated" }); return; } }

  const [job] = await db.select().from(repairJobsTable)
    .where(and(eq(repairJobsTable.id, jobId), eq(repairJobsTable.organizationId, orgId)));

  if (!job) { { res.status(404).json({ error: "Repair job not found" }); return; } }

  // Admin or the member themselves can view
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, req.user.id));
  const adminRoles = ["org_admin", "tournament_director", "committee_member", "competition_secretary", "pro_shop", "super_admin"];
  if (!adminRoles.includes(user?.role ?? "") && job.memberId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  res.json(formatJob(job));
});

/* PATCH /organizations/:orgId/repair-jobs/:jobId */
router.patch("/:jobId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const jobId = parseInt(String((req.params as Record<string, string>).jobId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(repairJobsTable)
    .where(and(eq(repairJobsTable.id, jobId), eq(repairJobsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Repair job not found" }); return; } }

  const { status, technicianId, technicianName, jobType, description, memberName, memberEmail, memberId, expectedCompletionDate, notes } = req.body;

  const updates: Partial<typeof repairJobsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (status !== undefined) updates.status = status;
  if (technicianId !== undefined) updates.technicianId = technicianId ? parseInt(technicianId) : null;
  if (technicianName !== undefined) updates.technicianName = technicianName;
  if (jobType !== undefined) updates.jobType = jobType;
  if (description !== undefined) updates.description = description;
  if (memberName !== undefined) updates.memberName = memberName;
  if (memberEmail !== undefined) updates.memberEmail = memberEmail;
  if (memberId !== undefined) updates.memberId = memberId ? parseInt(memberId) : null;
  if (expectedCompletionDate !== undefined) updates.expectedCompletionDate = expectedCompletionDate ? new Date(expectedCompletionDate) : null;
  if (notes !== undefined) updates.notes = notes;

  // Mark completed_at when status becomes collected
  if (status === "collected" && existing.status !== "collected") {
    updates.completedAt = new Date();
  }

  const [updated] = await db.update(repairJobsTable).set(updates)
    .where(and(eq(repairJobsTable.id, jobId), eq(repairJobsTable.organizationId, orgId)))
    .returning();

  // Send notification when status changes to ready_for_pickup
  if (status === "ready_for_pickup" && existing.status !== "ready_for_pickup" && !existing.notificationSentAt) {
    const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (org) {
      await notifyMemberReady(updated, org).catch(() => {});
      await db.update(repairJobsTable).set({ notificationSentAt: new Date() })
        .where(eq(repairJobsTable.id, jobId));
      updated.notificationSentAt = new Date();
    }
  }

  res.json(formatJob(updated));
});

/* DELETE /organizations/:orgId/repair-jobs/:jobId */
router.delete("/:jobId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const jobId = parseInt(String((req.params as Record<string, string>).jobId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(repairJobsTable)
    .where(and(eq(repairJobsTable.id, jobId), eq(repairJobsTable.organizationId, orgId)))
    .returning();

  if (!deleted) { { res.status(404).json({ error: "Repair job not found" }); return; } }
  res.json({ success: true });
});

// ─── Fitting Sessions ─────────────────────────────────────────────────────────

const fittingRouter = Router({ mergeParams: true });

/* POST /organizations/:orgId/fitting-sessions */
fittingRouter.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { memberName, memberEmail, memberId, scheduledAt, technicianId, technicianName, notes } = req.body;
  if (!memberName || !scheduledAt) {
    res.status(400).json({ error: "memberName and scheduledAt are required" });
    return;
  }

  const [session] = await db.insert(fittingSessionsTable).values({
    organizationId: orgId,
    memberName,
    memberEmail: memberEmail ?? null,
    memberId: memberId ? parseInt(memberId) : null,
    scheduledAt: new Date(scheduledAt),
    status: "booked",
    technicianId: technicianId ? parseInt(technicianId) : null,
    technicianName: technicianName ?? null,
    recommendedSpecs: {},
    notes: notes ?? null,
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(formatSession(session));
});

/* GET /organizations/:orgId/fitting-sessions */
fittingRouter.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status } = req.query as { status?: string };
  const conditions = [eq(fittingSessionsTable.organizationId, orgId)];
  if (status && ["booked", "completed", "cancelled"].includes(status)) {
    conditions.push(eq(fittingSessionsTable.status, status as any));
  }

  const sessions = await db.select().from(fittingSessionsTable)
    .where(and(...conditions))
    .orderBy(desc(fittingSessionsTable.scheduledAt));

  res.json(sessions.map(formatSession));
});

/* GET /organizations/:orgId/fitting-sessions/member/me */
fittingRouter.get("/member/me", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;

  const sessions = await db.select().from(fittingSessionsTable)
    .where(and(
      eq(fittingSessionsTable.organizationId, orgId),
      eq(fittingSessionsTable.memberId, member.dbUserId),
    ))
    .orderBy(desc(fittingSessionsTable.scheduledAt));

  res.json(sessions.map(formatSession));
});

/* GET /organizations/:orgId/fitting-sessions/:sessionId */
fittingRouter.get("/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  if (!req.user) { { res.status(401).json({ error: "Unauthenticated" }); return; } }

  const [session] = await db.select().from(fittingSessionsTable)
    .where(and(eq(fittingSessionsTable.id, sessionId), eq(fittingSessionsTable.organizationId, orgId)));

  if (!session) { { res.status(404).json({ error: "Fitting session not found" }); return; } }

  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, req.user.id));
  const adminRoles = ["org_admin", "tournament_director", "committee_member", "competition_secretary", "pro_shop", "super_admin"];
  if (!adminRoles.includes(user?.role ?? "") && session.memberId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  res.json(formatSession(session));
});

/* PATCH /organizations/:orgId/fitting-sessions/:sessionId */
fittingRouter.patch("/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(fittingSessionsTable)
    .where(and(eq(fittingSessionsTable.id, sessionId), eq(fittingSessionsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Fitting session not found" }); return; } }

  const { status, technicianId, technicianName, scheduledAt, memberName, memberEmail, memberId, recommendedSpecs, notes } = req.body;

  const updates: Partial<typeof fittingSessionsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (status !== undefined) updates.status = status;
  if (technicianId !== undefined) updates.technicianId = technicianId ? parseInt(technicianId) : null;
  if (technicianName !== undefined) updates.technicianName = technicianName;
  if (scheduledAt !== undefined) updates.scheduledAt = new Date(scheduledAt);
  if (memberName !== undefined) updates.memberName = memberName;
  if (memberEmail !== undefined) updates.memberEmail = memberEmail;
  if (memberId !== undefined) updates.memberId = memberId ? parseInt(memberId) : null;
  if (recommendedSpecs !== undefined) updates.recommendedSpecs = recommendedSpecs;
  if (notes !== undefined) updates.notes = notes;

  const [updated] = await db.update(fittingSessionsTable).set(updates)
    .where(and(eq(fittingSessionsTable.id, sessionId), eq(fittingSessionsTable.organizationId, orgId)))
    .returning();

  res.json(formatSession(updated));
});

/* DELETE /organizations/:orgId/fitting-sessions/:sessionId */
fittingRouter.delete("/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(fittingSessionsTable)
    .where(and(eq(fittingSessionsTable.id, sessionId), eq(fittingSessionsTable.organizationId, orgId)))
    .returning();

  if (!deleted) { { res.status(404).json({ error: "Fitting session not found" }); return; } }
  res.json({ success: true });
});

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatJob(job: typeof repairJobsTable.$inferSelect) {
  return {
    ...job,
    expectedCompletionDate: job.expectedCompletionDate?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    notificationSentAt: job.notificationSentAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function formatSession(session: typeof fittingSessionsTable.$inferSelect) {
  return {
    ...session,
    scheduledAt: session.scheduledAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export { fittingRouter };
export default router;
