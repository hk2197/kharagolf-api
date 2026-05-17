/**
 * Course Maintenance & Greenkeeper Logs API — Task #108
 *
 * Condition Reports:
 *   GET    /organizations/:orgId/maintenance/conditions          List reports
 *   POST   /organizations/:orgId/maintenance/conditions          Create report
 *   GET    /organizations/:orgId/maintenance/conditions/:id      Get report
 *   DELETE /organizations/:orgId/maintenance/conditions/:id      Delete report
 *   GET    /organizations/:orgId/maintenance/conditions/summary  Weekly summary
 *
 * Maintenance Tasks:
 *   GET    /organizations/:orgId/maintenance/tasks               List tasks
 *   POST   /organizations/:orgId/maintenance/tasks               Create task
 *   GET    /organizations/:orgId/maintenance/tasks/:id           Get task
 *   PATCH  /organizations/:orgId/maintenance/tasks/:id           Update task
 *   DELETE /organizations/:orgId/maintenance/tasks/:id           Delete task
 *   GET    /organizations/:orgId/maintenance/tasks/overdue       List overdue
 *
 * Equipment:
 *   GET    /organizations/:orgId/maintenance/equipment           List equipment
 *   POST   /organizations/:orgId/maintenance/equipment           Add equipment
 *   PATCH  /organizations/:orgId/maintenance/equipment/:id       Update equipment
 *   DELETE /organizations/:orgId/maintenance/equipment/:id       Delete equipment
 *   GET    /organizations/:orgId/maintenance/equipment/:id/service-logs
 *   POST   /organizations/:orgId/maintenance/equipment/:id/service-logs
 *   DELETE /organizations/:orgId/maintenance/equipment/:id/service-logs/:logId
 *
 * Course Notices:
 *   GET    /organizations/:orgId/maintenance/notices             List notices (admin)
 *   POST   /organizations/:orgId/maintenance/notices             Create notice
 *   PATCH  /organizations/:orgId/maintenance/notices/:id         Update notice
 *   DELETE /organizations/:orgId/maintenance/notices/:id         Delete notice
 *   POST   /organizations/:orgId/maintenance/notices/:id/publish Publish/unpublish
 *
 * Public:
 *   GET    /public/organizations/:orgId/course-conditions        Active notices + latest conditions
 */

import { Router, type Request, type Response } from "express";
import {
  db,
  courseConditionReportsTable,
  maintenanceTasksTable,
  equipmentRecordsTable,
  equipmentServiceLogsTable,
  courseNoticesTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, lt, gte, lte, or, inArray, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

async function requireOrgStaff(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if (
    (caller.role === "org_admin" || caller.role === "tournament_director" || caller.role === "volunteer") &&
    Number(caller.organizationId) === orgId
  ) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "volunteer"])));
  if (!m) { res.status(403).json({ error: "Staff access required" }); return false; }
  return true;
}

// ─── CONDITION REPORTS ────────────────────────────────────────────────────────

// GET /organizations/:orgId/maintenance/conditions/summary
router.get("/conditions/summary", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const since = new Date();
  since.setDate(since.getDate() - 7);

  const reports = await db.select().from(courseConditionReportsTable)
    .where(and(eq(courseConditionReportsTable.organizationId, orgId), gte(courseConditionReportsTable.reportDate, since)))
    .orderBy(desc(courseConditionReportsTable.reportDate));

  res.json({ reports, period: "7d" });
});

// GET /organizations/:orgId/maintenance/conditions
router.get("/conditions", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { area, limit = "50", offset = "0", since } = req.query as Record<string, string>;
  const conditions = [eq(courseConditionReportsTable.organizationId, orgId)];
  if (area) conditions.push(eq(courseConditionReportsTable.area, area as never));
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) conditions.push(gte(courseConditionReportsTable.reportDate, sinceDate));
  }

  const reports = await db
    .select({
      report: courseConditionReportsTable,
      reporterName: appUsersTable.displayName,
      reporterUsername: appUsersTable.username,
    })
    .from(courseConditionReportsTable)
    .leftJoin(appUsersTable, eq(courseConditionReportsTable.reportedById, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(courseConditionReportsTable.reportDate))
    .limit(Math.min(parseInt(limit), 200))
    .offset(parseInt(offset));

  res.json({ reports });
});

// POST /organizations/:orgId/maintenance/conditions
router.post("/conditions", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const {
    area, greenSpeed, fairwayCondition, greenCondition, teeCondition,
    roughCondition, bunkerCondition, notes, photoUrls, reportDate,
  } = req.body;

  if (!area) { { res.status(400).json({ error: "area is required" }); return; } }

  const [report] = await db.insert(courseConditionReportsTable).values({
    organizationId: orgId,
    reportedById: caller.id,
    area,
    greenSpeed: greenSpeed ? String(greenSpeed) : null,
    fairwayCondition: fairwayCondition || null,
    greenCondition: greenCondition || null,
    teeCondition: teeCondition || null,
    roughCondition: roughCondition || null,
    bunkerCondition: bunkerCondition || null,
    notes: notes || null,
    photoUrls: Array.isArray(photoUrls) ? photoUrls : [],
    reportDate: reportDate ? new Date(reportDate) : new Date(),
  }).returning();

  res.status(201).json({ report });
});

// GET /organizations/:orgId/maintenance/conditions/:id
router.get("/conditions/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const [report] = await db.select({
    report: courseConditionReportsTable,
    reporterName: appUsersTable.displayName,
    reporterUsername: appUsersTable.username,
  })
    .from(courseConditionReportsTable)
    .leftJoin(appUsersTable, eq(courseConditionReportsTable.reportedById, appUsersTable.id))
    .where(and(eq(courseConditionReportsTable.id, parseInt((req.params as Record<string, string>).id!)), eq(courseConditionReportsTable.organizationId, orgId)));

  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }
  res.json({ report });
});

// DELETE /organizations/:orgId/maintenance/conditions/:id
router.delete("/conditions/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(courseConditionReportsTable)
    .where(and(eq(courseConditionReportsTable.id, parseInt((req.params as Record<string, string>).id!)), eq(courseConditionReportsTable.organizationId, orgId)))
    .returning({ id: courseConditionReportsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Report not found" }); return; } }
  res.json({ ok: true });
});

// ─── MAINTENANCE TASKS ────────────────────────────────────────────────────────

// GET /organizations/:orgId/maintenance/tasks/overdue
router.get("/tasks/overdue", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const now = new Date();
  const tasks = await db
    .select({
      task: maintenanceTasksTable,
      assignedName: appUsersTable.displayName,
      assignedUsername: appUsersTable.username,
    })
    .from(maintenanceTasksTable)
    .leftJoin(appUsersTable, eq(maintenanceTasksTable.assignedToId, appUsersTable.id))
    .where(and(
      eq(maintenanceTasksTable.organizationId, orgId),
      inArray(maintenanceTasksTable.status, ["pending", "in_progress"]),
      lt(maintenanceTasksTable.dueDate, now),
    ))
    .orderBy(maintenanceTasksTable.dueDate);

  res.json({ tasks });
});

// GET /organizations/:orgId/maintenance/tasks
router.get("/tasks", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { status, priority, area, assignedToId, limit = "100", offset = "0" } = req.query as Record<string, string>;
  const conditions = [eq(maintenanceTasksTable.organizationId, orgId)];
  if (status) conditions.push(inArray(maintenanceTasksTable.status, status.split(",") as never[]));
  if (priority) conditions.push(eq(maintenanceTasksTable.priority, priority as never));
  if (area) conditions.push(eq(maintenanceTasksTable.area, area as never));
  if (assignedToId) conditions.push(eq(maintenanceTasksTable.assignedToId, parseInt(assignedToId)));

  const tasks = await db
    .select({
      task: maintenanceTasksTable,
      assignedName: appUsersTable.displayName,
      assignedUsername: appUsersTable.username,
    })
    .from(maintenanceTasksTable)
    .leftJoin(appUsersTable, eq(maintenanceTasksTable.assignedToId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(maintenanceTasksTable.updatedAt))
    .limit(Math.min(parseInt(limit), 500))
    .offset(parseInt(offset));

  res.json({ tasks });
});

// POST /organizations/:orgId/maintenance/tasks
router.post("/tasks", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { title, description, area, priority, assignedToId, dueDate, photoUrls } = req.body;
  if (!title?.trim()) { { res.status(400).json({ error: "title is required" }); return; } }

  const [task] = await db.insert(maintenanceTasksTable).values({
    organizationId: orgId,
    createdById: caller.id,
    title: title.trim(),
    description: description || null,
    area: area || null,
    priority: priority || "medium",
    assignedToId: assignedToId ? parseInt(assignedToId) : null,
    dueDate: dueDate ? new Date(dueDate) : null,
    photoUrls: Array.isArray(photoUrls) ? photoUrls : [],
  }).returning();

  res.status(201).json({ task });
});

// PATCH /organizations/:orgId/maintenance/tasks/:id
router.patch("/tasks/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const taskId = parseInt((req.params as Record<string, string>).id!);
  const [existing] = await db.select().from(maintenanceTasksTable)
    .where(and(eq(maintenanceTasksTable.id, taskId), eq(maintenanceTasksTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Task not found" }); return; } }

  const { title, description, area, priority, status, assignedToId, dueDate, completionNotes, photoUrls } = req.body;

  const updates: Partial<typeof existing> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title.trim();
  if (description !== undefined) updates.description = description || null;
  if (area !== undefined) updates.area = area || null;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) {
    updates.status = status;
    if (status === "completed" && !existing.completedAt) updates.completedAt = new Date();
    if (status !== "completed") updates.completedAt = null;
  }
  if (assignedToId !== undefined) updates.assignedToId = assignedToId ? parseInt(assignedToId) : null;
  if (dueDate !== undefined) updates.dueDate = dueDate ? new Date(dueDate) : null;
  if (completionNotes !== undefined) updates.completionNotes = completionNotes || null;
  if (photoUrls !== undefined) updates.photoUrls = Array.isArray(photoUrls) ? photoUrls : existing.photoUrls;

  const [task] = await db.update(maintenanceTasksTable).set(updates)
    .where(eq(maintenanceTasksTable.id, taskId)).returning();

  res.json({ task });
});

// DELETE /organizations/:orgId/maintenance/tasks/:id
router.delete("/tasks/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(maintenanceTasksTable)
    .where(and(eq(maintenanceTasksTable.id, parseInt((req.params as Record<string, string>).id!)), eq(maintenanceTasksTable.organizationId, orgId)))
    .returning({ id: maintenanceTasksTable.id });

  if (!deleted) { { res.status(404).json({ error: "Task not found" }); return; } }
  res.json({ ok: true });
});

// ─── EQUIPMENT ────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/maintenance/equipment
router.get("/equipment", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { active } = req.query as Record<string, string>;
  const conditions = [eq(equipmentRecordsTable.organizationId, orgId)];
  if (active === "true") conditions.push(eq(equipmentRecordsTable.isActive, true));

  const equipment = await db.select().from(equipmentRecordsTable)
    .where(and(...conditions))
    .orderBy(equipmentRecordsTable.name);

  res.json({ equipment });
});

// POST /organizations/:orgId/maintenance/equipment
router.post("/equipment", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, equipmentType, serialNumber, make, model, purchaseDate, notes } = req.body;
  if (!name?.trim()) { { res.status(400).json({ error: "name is required" }); return; } }
  if (!equipmentType) { { res.status(400).json({ error: "equipmentType is required" }); return; } }

  const [equipment] = await db.insert(equipmentRecordsTable).values({
    organizationId: orgId,
    name: name.trim(),
    equipmentType,
    serialNumber: serialNumber || null,
    make: make || null,
    model: model || null,
    purchaseDate: purchaseDate ? new Date(purchaseDate) : null,
    notes: notes || null,
  }).returning();

  res.status(201).json({ equipment });
});

// PATCH /organizations/:orgId/maintenance/equipment/:id
router.patch("/equipment/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const equipId = parseInt((req.params as Record<string, string>).id!);
  const [existing] = await db.select().from(equipmentRecordsTable)
    .where(and(eq(equipmentRecordsTable.id, equipId), eq(equipmentRecordsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Equipment not found" }); return; } }

  const { name, equipmentType, serialNumber, make, model, purchaseDate, isActive, notes } = req.body;
  const updates: Partial<typeof existing> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name.trim();
  if (equipmentType !== undefined) updates.equipmentType = equipmentType;
  if (serialNumber !== undefined) updates.serialNumber = serialNumber || null;
  if (make !== undefined) updates.make = make || null;
  if (model !== undefined) updates.model = model || null;
  if (purchaseDate !== undefined) updates.purchaseDate = purchaseDate ? new Date(purchaseDate) : null;
  if (isActive !== undefined) updates.isActive = Boolean(isActive);
  if (notes !== undefined) updates.notes = notes || null;

  const [equipment] = await db.update(equipmentRecordsTable).set(updates)
    .where(eq(equipmentRecordsTable.id, equipId)).returning();

  res.json({ equipment });
});

// DELETE /organizations/:orgId/maintenance/equipment/:id
router.delete("/equipment/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(equipmentRecordsTable)
    .where(and(eq(equipmentRecordsTable.id, parseInt((req.params as Record<string, string>).id!)), eq(equipmentRecordsTable.organizationId, orgId)))
    .returning({ id: equipmentRecordsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Equipment not found" }); return; } }
  res.json({ ok: true });
});

// GET /organizations/:orgId/maintenance/equipment/:id/service-logs
router.get("/equipment/:id/service-logs", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const equipId = parseInt((req.params as Record<string, string>).id!);
  const [equip] = await db.select({ id: equipmentRecordsTable.id }).from(equipmentRecordsTable)
    .where(and(eq(equipmentRecordsTable.id, equipId), eq(equipmentRecordsTable.organizationId, orgId)));
  if (!equip) { { res.status(404).json({ error: "Equipment not found" }); return; } }

  const logs = await db
    .select({
      log: equipmentServiceLogsTable,
      loggedByName: appUsersTable.displayName,
      loggedByUsername: appUsersTable.username,
    })
    .from(equipmentServiceLogsTable)
    .leftJoin(appUsersTable, eq(equipmentServiceLogsTable.loggedById, appUsersTable.id))
    .where(eq(equipmentServiceLogsTable.equipmentId, equipId))
    .orderBy(desc(equipmentServiceLogsTable.serviceDate));

  res.json({ logs });
});

// POST /organizations/:orgId/maintenance/equipment/:id/service-logs
router.post("/equipment/:id/service-logs", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const equipId = parseInt((req.params as Record<string, string>).id!);
  const [equip] = await db.select({ id: equipmentRecordsTable.id }).from(equipmentRecordsTable)
    .where(and(eq(equipmentRecordsTable.id, equipId), eq(equipmentRecordsTable.organizationId, orgId)));
  if (!equip) { { res.status(404).json({ error: "Equipment not found" }); return; } }

  const { serviceType, description, hoursAtService, nextServiceHours, nextServiceDate, cost, photoUrls, serviceDate } = req.body;
  if (!serviceType?.trim()) { { res.status(400).json({ error: "serviceType is required" }); return; } }

  const [log] = await db.insert(equipmentServiceLogsTable).values({
    equipmentId: equipId,
    organizationId: orgId,
    loggedById: caller.id,
    serviceType: serviceType.trim(),
    description: description || null,
    hoursAtService: hoursAtService ? String(hoursAtService) : null,
    nextServiceHours: nextServiceHours ? String(nextServiceHours) : null,
    nextServiceDate: nextServiceDate ? new Date(nextServiceDate) : null,
    cost: cost ? String(cost) : null,
    photoUrls: Array.isArray(photoUrls) ? photoUrls : [],
    serviceDate: serviceDate ? new Date(serviceDate) : new Date(),
  }).returning();

  res.status(201).json({ log });
});

// DELETE /organizations/:orgId/maintenance/equipment/:id/service-logs/:logId
router.delete("/equipment/:id/service-logs/:logId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(equipmentServiceLogsTable)
    .where(and(
      eq(equipmentServiceLogsTable.id, parseInt((req.params as Record<string, string>).logId!)),
      eq(equipmentServiceLogsTable.equipmentId, parseInt((req.params as Record<string, string>).id!)),
      eq(equipmentServiceLogsTable.organizationId, orgId),
    ))
    .returning({ id: equipmentServiceLogsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Service log not found" }); return; } }
  res.json({ ok: true });
});

// ─── COURSE NOTICES ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/maintenance/notices
router.get("/notices", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { published } = req.query as Record<string, string>;
  const conditions = [eq(courseNoticesTable.organizationId, orgId)];
  if (published === "true") conditions.push(eq(courseNoticesTable.isPublished, true));
  if (published === "false") conditions.push(eq(courseNoticesTable.isPublished, false));

  const notices = await db
    .select({
      notice: courseNoticesTable,
      createdByName: appUsersTable.displayName,
      createdByUsername: appUsersTable.username,
    })
    .from(courseNoticesTable)
    .leftJoin(appUsersTable, eq(courseNoticesTable.createdById, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(courseNoticesTable.isPinned), desc(courseNoticesTable.createdAt));

  res.json({ notices });
});

// POST /organizations/:orgId/maintenance/notices
router.post("/notices", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { title, body, noticeType, area, isPinned, expiresAt } = req.body;
  if (!title?.trim()) { { res.status(400).json({ error: "title is required" }); return; } }
  if (!body?.trim()) { { res.status(400).json({ error: "body is required" }); return; } }

  const [notice] = await db.insert(courseNoticesTable).values({
    organizationId: orgId,
    createdById: caller.id,
    title: title.trim(),
    body: body.trim(),
    noticeType: noticeType || "general",
    area: area || null,
    isPinned: Boolean(isPinned),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  }).returning();

  res.status(201).json({ notice });
});

// PATCH /organizations/:orgId/maintenance/notices/:id
router.patch("/notices/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const noticeId = parseInt((req.params as Record<string, string>).id!);
  const [existing] = await db.select().from(courseNoticesTable)
    .where(and(eq(courseNoticesTable.id, noticeId), eq(courseNoticesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Notice not found" }); return; } }

  const { title, body, noticeType, area, isPinned, expiresAt } = req.body;
  const updates: Partial<typeof existing> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title.trim();
  if (body !== undefined) updates.body = body.trim();
  if (noticeType !== undefined) updates.noticeType = noticeType;
  if (area !== undefined) updates.area = area || null;
  if (isPinned !== undefined) updates.isPinned = Boolean(isPinned);
  if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;

  const [notice] = await db.update(courseNoticesTable).set(updates)
    .where(eq(courseNoticesTable.id, noticeId)).returning();

  res.json({ notice });
});

// POST /organizations/:orgId/maintenance/notices/:id/publish
router.post("/notices/:id/publish", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const noticeId = parseInt((req.params as Record<string, string>).id!);
  const [existing] = await db.select().from(courseNoticesTable)
    .where(and(eq(courseNoticesTable.id, noticeId), eq(courseNoticesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Notice not found" }); return; } }

  const { publish } = req.body;
  const isPublished = publish !== false;

  const [notice] = await db.update(courseNoticesTable).set({
    isPublished,
    publishedAt: isPublished ? (existing.publishedAt ?? new Date()) : null,
    updatedAt: new Date(),
  }).where(eq(courseNoticesTable.id, noticeId)).returning();

  res.json({ notice });
});

// DELETE /organizations/:orgId/maintenance/notices/:id
router.delete("/notices/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [deleted] = await db.delete(courseNoticesTable)
    .where(and(eq(courseNoticesTable.id, parseInt((req.params as Record<string, string>).id!)), eq(courseNoticesTable.organizationId, orgId)))
    .returning({ id: courseNoticesTable.id });

  if (!deleted) { { res.status(404).json({ error: "Notice not found" }); return; } }
  res.json({ ok: true });
});

// ─── PUBLIC COURSE CONDITIONS ─────────────────────────────────────────────────

export const publicCourseConditionsRouter = Router({ mergeParams: true });

// GET /public/organizations/:orgId/course-conditions
publicCourseConditionsRouter.get("/organizations/:orgId/course-conditions", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId!);
  const now = new Date();

  const notices = await db.select().from(courseNoticesTable)
    .where(and(
      eq(courseNoticesTable.organizationId, orgId),
      eq(courseNoticesTable.isPublished, true),
      or(
        sql`${courseNoticesTable.expiresAt} IS NULL`,
        gte(courseNoticesTable.expiresAt, now),
      ),
    ))
    .orderBy(desc(courseNoticesTable.isPinned), desc(courseNoticesTable.publishedAt));

  const since = new Date();
  since.setDate(since.getDate() - 1);
  const latestReports = await db.select({
    report: courseConditionReportsTable,
  })
    .from(courseConditionReportsTable)
    .where(and(
      eq(courseConditionReportsTable.organizationId, orgId),
      gte(courseConditionReportsTable.reportDate, since),
    ))
    .orderBy(desc(courseConditionReportsTable.reportDate))
    .limit(50);

  res.json({ notices, latestReports });
});

export default router;
