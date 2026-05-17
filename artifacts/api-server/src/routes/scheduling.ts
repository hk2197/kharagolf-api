/**
 * Staff Scheduling & Roster Management API — Task #110
 * Base: /organizations/:orgId/scheduling
 *
 * Staff Profiles (admin)
 * GET    /staff                          List staff profiles
 * POST   /staff                          Create staff profile
 * GET    /staff/:staffId                 Get a staff profile
 * PATCH  /staff/:staffId                 Update staff profile
 * DELETE /staff/:staffId                 Deactivate staff profile
 *
 * Rosters (admin)
 * GET    /rosters                        List rosters
 * POST   /rosters                        Create roster
 * GET    /rosters/:rosterId              Get roster with shifts
 * PATCH  /rosters/:rosterId              Update roster
 * DELETE /rosters/:rosterId              Delete roster
 * POST   /rosters/:rosterId/publish      Publish roster (notify staff)
 *
 * Shifts (admin)
 * GET    /shifts                         List shifts (filterable)
 * POST   /shifts                         Create shift
 * PATCH  /shifts/:shiftId               Update shift
 * DELETE /shifts/:shiftId               Delete shift
 * POST   /shifts/:shiftId/confirm        Staff confirms shift
 *
 * Leave Requests
 * GET    /leave                          List leave requests (admin: all; staff: own)
 * POST   /leave                          Submit leave request (staff)
 * GET    /leave/:leaveId                 Get leave request
 * PATCH  /leave/:leaveId/approve         Approve leave request (admin)
 * PATCH  /leave/:leaveId/reject          Reject leave request (admin)
 * PATCH  /leave/:leaveId/cancel          Cancel leave request (staff)
 *
 * Timesheets
 * GET    /timesheets                     List timesheet entries
 * POST   /timesheets/clock-in            Clock in (PIN or admin)
 * POST   /timesheets/clock-out           Clock out
 * POST   /timesheets/manual              Manual entry (admin)
 * PATCH  /timesheets/:entryId            Update entry (admin)
 * PATCH  /timesheets/:entryId/approve    Approve timesheet entry (admin)
 * GET    /timesheets/export              Export CSV for pay period
 *
 * Overtime Rules (admin)
 * GET    /overtime-rules                 Get overtime config
 * POST   /overtime-rules                 Create overtime config
 * PATCH  /overtime-rules/:ruleId        Update overtime config
 *
 * My Schedules (portal staff)
 * GET    /my-shifts                      Authenticated staff member's upcoming shifts
 * GET    /my-leave                       Authenticated staff member's leave
 * GET    /my-timesheets                  Authenticated staff member's timesheet history
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  staffProfilesTable,
  rostersTable,
  shiftsTable,
  leaveRequestsTable,
  timesheetEntriesTable,
  overtimeRulesTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, or, sql, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser {
  id: number;
  role?: string;
  organizationId?: number | null;
  displayName?: string;
  email?: string;
}

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

function parseOrgId(req: Request): number {
  return parseInt(String((req.params as Record<string, string>).orgId));
}

async function requireAuth(req: Request, res: Response): Promise<SessionUser | null> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  return getUser(req) ?? null;
}

async function getStaffProfileForUser(
  userId: number,
  orgId: number,
): Promise<typeof staffProfilesTable.$inferSelect | null> {
  const [profile] = await db
    .select()
    .from(staffProfilesTable)
    .where(
      and(
        eq(staffProfilesTable.organizationId, orgId),
        eq(staffProfilesTable.userId, userId),
        eq(staffProfilesTable.isActive, true),
      ),
    );
  return profile ?? null;
}

// ─── STAFF PROFILES ───────────────────────────────────────────────────────────

router.get("/staff", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { department, activeOnly } = req.query;
  const conditions: ReturnType<typeof eq>[] = [eq(staffProfilesTable.organizationId, orgId)];
  if (department) conditions.push(eq(staffProfilesTable.department, department as never));
  if (activeOnly !== "false") conditions.push(eq(staffProfilesTable.isActive, true));

  const profiles = await db
    .select({
      id: staffProfilesTable.id,
      userId: staffProfilesTable.userId,
      firstName: staffProfilesTable.firstName,
      lastName: staffProfilesTable.lastName,
      email: staffProfilesTable.email,
      phone: staffProfilesTable.phone,
      department: staffProfilesTable.department,
      position: staffProfilesTable.position,
      employmentType: staffProfilesTable.employmentType,
      hourlyRate: staffProfilesTable.hourlyRate,
      currency: staffProfilesTable.currency,
      annualLeaveBalance: staffProfilesTable.annualLeaveBalance,
      sickLeaveBalance: staffProfilesTable.sickLeaveBalance,
      isActive: staffProfilesTable.isActive,
      notes: staffProfilesTable.notes,
      createdAt: staffProfilesTable.createdAt,
    })
    .from(staffProfilesTable)
    .where(and(...conditions))
    .orderBy(staffProfilesTable.lastName, staffProfilesTable.firstName);

  res.json(profiles);
});

router.post("/staff", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const { firstName, lastName, email, phone, department, position, employmentType, hourlyRate, currency, annualLeaveBalance, sickLeaveBalance, notes, pin } = req.body;
  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }

  let linkedUserId: number | undefined;
  if (email) {
    const [appUser] = await db.select({ id: appUsersTable.id }).from(appUsersTable).where(eq(appUsersTable.email, email.toLowerCase().trim()));
    if (appUser) linkedUserId = appUser.id;
  }

  const [profile] = await db
    .insert(staffProfilesTable)
    .values({
      organizationId: orgId,
      userId: linkedUserId,
      firstName,
      lastName,
      email: email ? email.toLowerCase().trim() : null,
      phone,
      department: department || "pro_shop",
      position,
      employmentType: employmentType || "full_time",
      pin: pin || null,
      hourlyRate: hourlyRate ? String(hourlyRate) : null,
      currency: currency || "INR",
      annualLeaveBalance: annualLeaveBalance ? String(annualLeaveBalance) : "0",
      sickLeaveBalance: sickLeaveBalance ? String(sickLeaveBalance) : "0",
      notes,
      createdByUserId: user.id,
    })
    .returning();

  res.status(201).json(profile);
});

router.get("/staff/:staffId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const staffId = parseInt(String((req.params as Record<string, string>).staffId));
  const [profile] = await db
    .select()
    .from(staffProfilesTable)
    .where(and(eq(staffProfilesTable.id, staffId), eq(staffProfilesTable.organizationId, orgId)));

  if (!profile) { { res.status(404).json({ error: "Staff profile not found" }); return; } }
  res.json(profile);
});

router.patch("/staff/:staffId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const staffId = parseInt(String((req.params as Record<string, string>).staffId));
  const [existing] = await db.select({ id: staffProfilesTable.id }).from(staffProfilesTable).where(and(eq(staffProfilesTable.id, staffId), eq(staffProfilesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Staff profile not found" }); return; } }

  const updates: Partial<{
    firstName: string; lastName: string; email: string | null; phone: string | null;
    department: string; position: string | null; employmentType: string; pin: string | null;
    hourlyRate: string | null; currency: string; annualLeaveBalance: string; sickLeaveBalance: string;
    isActive: boolean; notes: string | null; updatedAt: Date;
  }> = { updatedAt: new Date() };

  if ("firstName" in req.body) updates.firstName = req.body.firstName;
  if ("lastName" in req.body) updates.lastName = req.body.lastName;
  if ("email" in req.body) updates.email = req.body.email ? req.body.email.toLowerCase().trim() : null;
  if ("phone" in req.body) updates.phone = req.body.phone;
  if ("department" in req.body) updates.department = req.body.department;
  if ("position" in req.body) updates.position = req.body.position;
  if ("employmentType" in req.body) updates.employmentType = req.body.employmentType;
  if ("pin" in req.body) updates.pin = req.body.pin;
  if ("hourlyRate" in req.body) updates.hourlyRate = req.body.hourlyRate != null ? String(req.body.hourlyRate) : null;
  if ("currency" in req.body) updates.currency = req.body.currency;
  if ("annualLeaveBalance" in req.body) updates.annualLeaveBalance = String(req.body.annualLeaveBalance);
  if ("sickLeaveBalance" in req.body) updates.sickLeaveBalance = String(req.body.sickLeaveBalance);
  if ("isActive" in req.body) updates.isActive = req.body.isActive;
  if ("notes" in req.body) updates.notes = req.body.notes;

  const [updated] = await db.update(staffProfilesTable).set(updates as Record<string, never>).where(and(eq(staffProfilesTable.id, staffId), eq(staffProfilesTable.organizationId, orgId))).returning();
  res.json(updated);
});

router.delete("/staff/:staffId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const staffId = parseInt(String((req.params as Record<string, string>).staffId));
  await db.update(staffProfilesTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(staffProfilesTable.id, staffId), eq(staffProfilesTable.organizationId, orgId)));
  res.json({ success: true });
});

// ─── ROSTERS ──────────────────────────────────────────────────────────────────

router.get("/rosters", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { department, from, to } = req.query;
  const conditions = [eq(rostersTable.organizationId, orgId)];
  if (department) conditions.push(eq(rostersTable.department, department as never));
  if (from) conditions.push(gte(rostersTable.startDate, String(from)));
  if (to) conditions.push(lte(rostersTable.endDate, String(to)));

  const rosters = await db.select().from(rostersTable).where(and(...conditions)).orderBy(desc(rostersTable.startDate));
  res.json(rosters);
});

router.post("/rosters", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const { name, department, period, startDate, endDate, notes } = req.body;
  if (!name || !startDate || !endDate) {
    res.status(400).json({ error: "name, startDate, and endDate are required" });
    return;
  }

  const [roster] = await db.insert(rostersTable).values({
    organizationId: orgId,
    name,
    department: department || null,
    period: period || "weekly",
    startDate,
    endDate,
    notes,
    createdByUserId: user.id,
  }).returning();

  res.status(201).json(roster);
});

router.get("/rosters/:rosterId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  const [roster] = await db.select().from(rostersTable).where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId)));
  if (!roster) { { res.status(404).json({ error: "Roster not found" }); return; } }

  const shifts = await db
    .select({
      id: shiftsTable.id,
      staffProfileId: shiftsTable.staffProfileId,
      staffName: sql<string>`${staffProfilesTable.firstName} || ' ' || ${staffProfilesTable.lastName}`,
      date: shiftsTable.date,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      department: shiftsTable.department,
      role: shiftsTable.role,
      status: shiftsTable.status,
      notes: shiftsTable.notes,
    })
    .from(shiftsTable)
    .leftJoin(staffProfilesTable, eq(staffProfilesTable.id, shiftsTable.staffProfileId))
    .where(eq(shiftsTable.rosterId, rosterId))
    .orderBy(shiftsTable.date, shiftsTable.startTime);

  res.json({ ...roster, shifts });
});

router.patch("/rosters/:rosterId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  const [existing] = await db.select({ id: rostersTable.id }).from(rostersTable).where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Roster not found" }); return; } }

  const { name, department, period, startDate, endDate, notes } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (department !== undefined) updates.department = department;
  if (period !== undefined) updates.period = period;
  if (startDate !== undefined) updates.startDate = startDate;
  if (endDate !== undefined) updates.endDate = endDate;
  if (notes !== undefined) updates.notes = notes;

  const [updated] = await db.update(rostersTable).set(updates).where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId))).returning();
  res.json(updated);
});

router.delete("/rosters/:rosterId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  await db.delete(rostersTable).where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId)));
  res.json({ success: true });
});

router.post("/rosters/:rosterId/publish", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const rosterId = parseInt(String((req.params as Record<string, string>).rosterId));
  const [existing] = await db.select().from(rostersTable).where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Roster not found" }); return; } }

  const now = new Date();
  const [updated] = await db
    .update(rostersTable)
    .set({ isPublished: true, publishedAt: now, publishedByUserId: user.id, updatedAt: now })
    .where(and(eq(rostersTable.id, rosterId), eq(rostersTable.organizationId, orgId)))
    .returning();

  await db.update(shiftsTable).set({ status: "published", updatedAt: now }).where(and(eq(shiftsTable.rosterId, rosterId), eq(shiftsTable.status, "draft")));

  res.json(updated);
});

// ─── SHIFTS ───────────────────────────────────────────────────────────────────

router.get("/shifts", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { staffProfileId, rosterId, department, from, to, status } = req.query;
  const conditions = [eq(shiftsTable.organizationId, orgId)];
  if (staffProfileId) conditions.push(eq(shiftsTable.staffProfileId, parseInt(String(staffProfileId))));
  if (rosterId) conditions.push(eq(shiftsTable.rosterId, parseInt(String(rosterId))));
  if (department) conditions.push(eq(shiftsTable.department, department as never));
  if (from) conditions.push(gte(shiftsTable.date, String(from)));
  if (to) conditions.push(lte(shiftsTable.date, String(to)));
  if (status) conditions.push(eq(shiftsTable.status, status as never));

  const shifts = await db
    .select({
      id: shiftsTable.id,
      rosterId: shiftsTable.rosterId,
      staffProfileId: shiftsTable.staffProfileId,
      staffFirstName: staffProfilesTable.firstName,
      staffLastName: staffProfilesTable.lastName,
      date: shiftsTable.date,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      department: shiftsTable.department,
      role: shiftsTable.role,
      status: shiftsTable.status,
      notes: shiftsTable.notes,
      createdAt: shiftsTable.createdAt,
    })
    .from(shiftsTable)
    .leftJoin(staffProfilesTable, eq(staffProfilesTable.id, shiftsTable.staffProfileId))
    .where(and(...conditions))
    .orderBy(shiftsTable.date, shiftsTable.startTime);

  res.json(shifts);
});

router.post("/shifts", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const { rosterId, staffProfileId, date, startTime, endTime, department, role, notes } = req.body;
  if (!staffProfileId || !date || !startTime || !endTime) {
    res.status(400).json({ error: "staffProfileId, date, startTime, and endTime are required" });
    return;
  }

  const [staffProfile] = await db.select({ id: staffProfilesTable.id }).from(staffProfilesTable).where(and(eq(staffProfilesTable.id, parseInt(String(staffProfileId))), eq(staffProfilesTable.organizationId, orgId)));
  if (!staffProfile) { { res.status(404).json({ error: "Staff profile not found" }); return; } }

  const [shift] = await db.insert(shiftsTable).values({
    organizationId: orgId,
    rosterId: rosterId ? parseInt(String(rosterId)) : null,
    staffProfileId: parseInt(String(staffProfileId)),
    date,
    startTime,
    endTime,
    department: department || "pro_shop",
    role: role || null,
    notes,
    createdByUserId: user.id,
  }).returning();

  res.status(201).json(shift);
});

router.patch("/shifts/:shiftId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const shiftId = parseInt(String((req.params as Record<string, string>).shiftId));
  const [existing] = await db.select({ id: shiftsTable.id }).from(shiftsTable).where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Shift not found" }); return; } }

  const { date, startTime, endTime, department, role, status, notes } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (date !== undefined) updates.date = date;
  if (startTime !== undefined) updates.startTime = startTime;
  if (endTime !== undefined) updates.endTime = endTime;
  if (department !== undefined) updates.department = department;
  if (role !== undefined) updates.role = role;
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;

  const [updated] = await db.update(shiftsTable).set(updates).where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.organizationId, orgId))).returning();
  res.json(updated);
});

router.delete("/shifts/:shiftId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const shiftId = parseInt(String((req.params as Record<string, string>).shiftId));
  await db.delete(shiftsTable).where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.organizationId, orgId)));
  res.json({ success: true });
});

router.post("/shifts/:shiftId/confirm", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const shiftId = parseInt(String((req.params as Record<string, string>).shiftId));
  const [shift] = await db.select().from(shiftsTable).where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.organizationId, orgId)));
  if (!shift) { { res.status(404).json({ error: "Shift not found" }); return; } }

  const staffProfile = await getStaffProfileForUser(user.id, orgId);
  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  if (!isAdmin && (!staffProfile || staffProfile.id !== shift.staffProfileId)) {
    res.status(403).json({ error: "You can only confirm your own shifts" });
    return;
  }

  const [updated] = await db.update(shiftsTable).set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() }).where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.organizationId, orgId))).returning();
  res.json(updated);
});

// ─── LEAVE REQUESTS ───────────────────────────────────────────────────────────

router.get("/leave", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  const { staffProfileId, status, from, to } = req.query;

  const conditions = [eq(leaveRequestsTable.organizationId, orgId)];
  if (!isAdmin) {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile) { { res.json([]); return; } }
    conditions.push(eq(leaveRequestsTable.staffProfileId, staffProfile.id));
  } else {
    if (staffProfileId) conditions.push(eq(leaveRequestsTable.staffProfileId, parseInt(String(staffProfileId))));
  }
  if (status) conditions.push(eq(leaveRequestsTable.status, status as never));
  if (from) conditions.push(gte(leaveRequestsTable.startDate, String(from)));
  if (to) conditions.push(lte(leaveRequestsTable.endDate, String(to)));

  const requests = await db
    .select({
      id: leaveRequestsTable.id,
      staffProfileId: leaveRequestsTable.staffProfileId,
      staffFirstName: staffProfilesTable.firstName,
      staffLastName: staffProfilesTable.lastName,
      leaveType: leaveRequestsTable.leaveType,
      startDate: leaveRequestsTable.startDate,
      endDate: leaveRequestsTable.endDate,
      totalDays: leaveRequestsTable.totalDays,
      reason: leaveRequestsTable.reason,
      status: leaveRequestsTable.status,
      reviewNotes: leaveRequestsTable.reviewNotes,
      reviewedAt: leaveRequestsTable.reviewedAt,
      createdAt: leaveRequestsTable.createdAt,
    })
    .from(leaveRequestsTable)
    .leftJoin(staffProfilesTable, eq(staffProfilesTable.id, leaveRequestsTable.staffProfileId))
    .where(and(...conditions))
    .orderBy(desc(leaveRequestsTable.createdAt));

  res.json(requests);
});

router.post("/leave", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  const { staffProfileId, leaveType, startDate, endDate, totalDays, reason } = req.body;

  if (!leaveType || !startDate || !endDate || !totalDays) {
    res.status(400).json({ error: "leaveType, startDate, endDate, and totalDays are required" });
    return;
  }

  let targetProfileId: number;
  if (isAdmin && staffProfileId) {
    targetProfileId = parseInt(String(staffProfileId));
  } else {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile) { { res.status(403).json({ error: "No staff profile found for your account" }); return; } }
    targetProfileId = staffProfile.id;
  }

  const [request] = await db.insert(leaveRequestsTable).values({
    organizationId: orgId,
    staffProfileId: targetProfileId,
    leaveType,
    startDate,
    endDate,
    totalDays: String(totalDays),
    reason,
  }).returning();

  res.status(201).json(request);
});

router.patch("/leave/:leaveId/approve", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const leaveId = parseInt(String((req.params as Record<string, string>).leaveId));
  const [existing] = await db.select().from(leaveRequestsTable).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Leave request not found" }); return; } }

  const now = new Date();
  const [updated] = await db.update(leaveRequestsTable).set({
    status: "approved",
    reviewedByUserId: user.id,
    reviewedAt: now,
    reviewNotes: req.body.reviewNotes || null,
    updatedAt: now,
  }).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId))).returning();

  if (existing.leaveType === "annual") {
    await db.update(staffProfilesTable).set({
      annualLeaveBalance: sql`${staffProfilesTable.annualLeaveBalance} - ${existing.totalDays}`,
      updatedAt: now,
    }).where(eq(staffProfilesTable.id, existing.staffProfileId));
  } else if (existing.leaveType === "sick") {
    await db.update(staffProfilesTable).set({
      sickLeaveBalance: sql`${staffProfilesTable.sickLeaveBalance} - ${existing.totalDays}`,
      updatedAt: now,
    }).where(eq(staffProfilesTable.id, existing.staffProfileId));
  }

  res.json(updated);
});

router.patch("/leave/:leaveId/reject", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const leaveId = parseInt(String((req.params as Record<string, string>).leaveId));
  const [existing] = await db.select({ id: leaveRequestsTable.id }).from(leaveRequestsTable).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Leave request not found" }); return; } }

  const now = new Date();
  const [updated] = await db.update(leaveRequestsTable).set({
    status: "rejected",
    reviewedByUserId: user.id,
    reviewedAt: now,
    reviewNotes: req.body.reviewNotes || null,
    updatedAt: now,
  }).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId))).returning();

  res.json(updated);
});

router.patch("/leave/:leaveId/cancel", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const leaveId = parseInt(String((req.params as Record<string, string>).leaveId));
  const [existing] = await db.select().from(leaveRequestsTable).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Leave request not found" }); return; } }

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  if (!isAdmin) {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile || staffProfile.id !== existing.staffProfileId) {
      res.status(403).json({ error: "You can only cancel your own leave requests" });
      return;
    }
  }

  const [updated] = await db.update(leaveRequestsTable).set({
    status: "cancelled",
    updatedAt: new Date(),
  }).where(and(eq(leaveRequestsTable.id, leaveId), eq(leaveRequestsTable.organizationId, orgId))).returning();

  res.json(updated);
});

// ─── TIMESHEETS ───────────────────────────────────────────────────────────────

function computeMinutes(clockIn: string, clockOut: string, breakMinutes = 0): number {
  const [inH, inM] = clockIn.split(":").map(Number);
  const [outH, outM] = clockOut.split(":").map(Number);
  return Math.max(0, (outH * 60 + outM) - (inH * 60 + inM) - breakMinutes);
}

router.get("/timesheets", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  const { staffProfileId, from, to, isApproved } = req.query;

  const conditions = [eq(timesheetEntriesTable.organizationId, orgId)];
  if (!isAdmin) {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile) { { res.json([]); return; } }
    conditions.push(eq(timesheetEntriesTable.staffProfileId, staffProfile.id));
  } else {
    if (staffProfileId) conditions.push(eq(timesheetEntriesTable.staffProfileId, parseInt(String(staffProfileId))));
  }
  if (from) conditions.push(gte(timesheetEntriesTable.date, String(from)));
  if (to) conditions.push(lte(timesheetEntriesTable.date, String(to)));
  if (isApproved !== undefined) conditions.push(eq(timesheetEntriesTable.isApproved, isApproved === "true"));

  const entries = await db
    .select({
      id: timesheetEntriesTable.id,
      staffProfileId: timesheetEntriesTable.staffProfileId,
      staffFirstName: staffProfilesTable.firstName,
      staffLastName: staffProfilesTable.lastName,
      shiftId: timesheetEntriesTable.shiftId,
      date: timesheetEntriesTable.date,
      clockIn: timesheetEntriesTable.clockIn,
      clockOut: timesheetEntriesTable.clockOut,
      breakMinutes: timesheetEntriesTable.breakMinutes,
      totalMinutes: timesheetEntriesTable.totalMinutes,
      regularMinutes: timesheetEntriesTable.regularMinutes,
      overtimeMinutes: timesheetEntriesTable.overtimeMinutes,
      isManualEntry: timesheetEntriesTable.isManualEntry,
      isApproved: timesheetEntriesTable.isApproved,
      notes: timesheetEntriesTable.notes,
      createdAt: timesheetEntriesTable.createdAt,
    })
    .from(timesheetEntriesTable)
    .leftJoin(staffProfilesTable, eq(staffProfilesTable.id, timesheetEntriesTable.staffProfileId))
    .where(and(...conditions))
    .orderBy(desc(timesheetEntriesTable.date));

  res.json(entries);
});

router.post("/timesheets/clock-in", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  const { pin, staffProfileId: bodyStaffProfileId, date, shiftId } = req.body;

  let targetProfileId: number;
  if (isAdmin && bodyStaffProfileId) {
    targetProfileId = parseInt(String(bodyStaffProfileId));
  } else if (pin) {
    const [profile] = await db.select({ id: staffProfilesTable.id }).from(staffProfilesTable).where(and(eq(staffProfilesTable.organizationId, orgId), eq(staffProfilesTable.pin, String(pin)), eq(staffProfilesTable.isActive, true)));
    if (!profile) { { res.status(401).json({ error: "Invalid PIN" }); return; } }
    targetProfileId = profile.id;
  } else {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile) { { res.status(403).json({ error: "No staff profile found" }); return; } }
    targetProfileId = staffProfile.id;
  }

  const entryDate = date || new Date().toISOString().split("T")[0];
  const clockInTime = new Date().toTimeString().slice(0, 5);

  const [existing] = await db.select({ id: timesheetEntriesTable.id, clockOut: timesheetEntriesTable.clockOut }).from(timesheetEntriesTable).where(and(eq(timesheetEntriesTable.staffProfileId, targetProfileId), eq(timesheetEntriesTable.date, entryDate)));
  if (existing) {
    if (!existing.clockOut) { { res.status(409).json({ error: "Already clocked in for today" }); return; } }
  }

  const [entry] = await db.insert(timesheetEntriesTable).values({
    organizationId: orgId,
    staffProfileId: targetProfileId,
    shiftId: shiftId ? parseInt(String(shiftId)) : null,
    date: entryDate,
    clockIn: clockInTime,
  }).returning();

  res.status(201).json(entry);
});

router.post("/timesheets/clock-out", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const isAdmin = ["org_admin", "super_admin", "tournament_director"].includes(user.role ?? "");
  const { pin, staffProfileId: bodyStaffProfileId, date, breakMinutes } = req.body;

  let targetProfileId: number;
  if (isAdmin && bodyStaffProfileId) {
    targetProfileId = parseInt(String(bodyStaffProfileId));
  } else if (pin) {
    const [profile] = await db.select({ id: staffProfilesTable.id }).from(staffProfilesTable).where(and(eq(staffProfilesTable.organizationId, orgId), eq(staffProfilesTable.pin, String(pin)), eq(staffProfilesTable.isActive, true)));
    if (!profile) { { res.status(401).json({ error: "Invalid PIN" }); return; } }
    targetProfileId = profile.id;
  } else {
    const staffProfile = await getStaffProfileForUser(user.id, orgId);
    if (!staffProfile) { { res.status(403).json({ error: "No staff profile found" }); return; } }
    targetProfileId = staffProfile.id;
  }

  const entryDate = date || new Date().toISOString().split("T")[0];
  const clockOutTime = new Date().toTimeString().slice(0, 5);

  const [existing] = await db.select().from(timesheetEntriesTable).where(and(eq(timesheetEntriesTable.staffProfileId, targetProfileId), eq(timesheetEntriesTable.date, entryDate), eq(timesheetEntriesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "No clock-in record found for today" }); return; } }
  if (existing.clockOut) { { res.status(409).json({ error: "Already clocked out" }); return; } }

  const breaks = breakMinutes ? parseInt(String(breakMinutes)) : 0;
  const total = existing.clockIn ? computeMinutes(existing.clockIn, clockOutTime, breaks) : 0;
  const regularMaxMinutes = 8 * 60;
  const regularMinutes = Math.min(total, regularMaxMinutes);
  const overtimeMinutes = Math.max(0, total - regularMaxMinutes);

  const [updated] = await db.update(timesheetEntriesTable).set({
    clockOut: clockOutTime,
    breakMinutes: breaks,
    totalMinutes: total,
    regularMinutes,
    overtimeMinutes,
    updatedAt: new Date(),
  }).where(eq(timesheetEntriesTable.id, existing.id)).returning();

  res.json(updated);
});

router.post("/timesheets/manual", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const { staffProfileId, date, clockIn, clockOut, breakMinutes, notes, shiftId } = req.body;
  if (!staffProfileId || !date || !clockIn || !clockOut) {
    res.status(400).json({ error: "staffProfileId, date, clockIn, and clockOut are required" });
    return;
  }

  const breaks = breakMinutes ? parseInt(String(breakMinutes)) : 0;
  const total = computeMinutes(String(clockIn), String(clockOut), breaks);
  const regularMaxMinutes = 8 * 60;
  const regularMinutes = Math.min(total, regularMaxMinutes);
  const overtimeMinutes = Math.max(0, total - regularMaxMinutes);

  const [entry] = await db.insert(timesheetEntriesTable).values({
    organizationId: orgId,
    staffProfileId: parseInt(String(staffProfileId)),
    shiftId: shiftId ? parseInt(String(shiftId)) : null,
    date,
    clockIn,
    clockOut,
    breakMinutes: breaks,
    totalMinutes: total,
    regularMinutes,
    overtimeMinutes,
    isManualEntry: true,
  }).returning();

  res.status(201).json(entry);
});

router.patch("/timesheets/:entryId/approve", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const user = getUser(req)!;

  const entryId = parseInt(String((req.params as Record<string, string>).entryId));
  const now = new Date();
  const [updated] = await db.update(timesheetEntriesTable).set({
    isApproved: true,
    approvedByUserId: user.id,
    approvedAt: now,
    updatedAt: now,
  }).where(and(eq(timesheetEntriesTable.id, entryId), eq(timesheetEntriesTable.organizationId, orgId))).returning();

  if (!updated) { { res.status(404).json({ error: "Timesheet entry not found" }); return; } }
  res.json(updated);
});

router.get("/timesheets/export", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { from, to, staffProfileId } = req.query;
  if (!from || !to) { { res.status(400).json({ error: "from and to date params are required" }); return; } }

  const conditions = [
    eq(timesheetEntriesTable.organizationId, orgId),
    gte(timesheetEntriesTable.date, String(from)),
    lte(timesheetEntriesTable.date, String(to)),
  ];
  if (staffProfileId) conditions.push(eq(timesheetEntriesTable.staffProfileId, parseInt(String(staffProfileId))));

  const entries = await db
    .select({
      staffId: timesheetEntriesTable.staffProfileId,
      firstName: staffProfilesTable.firstName,
      lastName: staffProfilesTable.lastName,
      department: staffProfilesTable.department,
      date: timesheetEntriesTable.date,
      clockIn: timesheetEntriesTable.clockIn,
      clockOut: timesheetEntriesTable.clockOut,
      breakMinutes: timesheetEntriesTable.breakMinutes,
      totalMinutes: timesheetEntriesTable.totalMinutes,
      regularMinutes: timesheetEntriesTable.regularMinutes,
      overtimeMinutes: timesheetEntriesTable.overtimeMinutes,
      isManualEntry: timesheetEntriesTable.isManualEntry,
      isApproved: timesheetEntriesTable.isApproved,
    })
    .from(timesheetEntriesTable)
    .leftJoin(staffProfilesTable, eq(staffProfilesTable.id, timesheetEntriesTable.staffProfileId))
    .where(and(...conditions))
    .orderBy(staffProfilesTable.lastName, staffProfilesTable.firstName, timesheetEntriesTable.date);

  const header = "Staff ID,First Name,Last Name,Department,Date,Clock In,Clock Out,Break (min),Total (min),Regular (min),Overtime (min),Manual Entry,Approved\n";
  const rows = entries.map((e) =>
    [
      e.staffId,
      `"${e.firstName}"`,
      `"${e.lastName}"`,
      e.department,
      e.date,
      e.clockIn ?? "",
      e.clockOut ?? "",
      e.breakMinutes ?? 0,
      e.totalMinutes ?? 0,
      e.regularMinutes ?? 0,
      e.overtimeMinutes ?? 0,
      e.isManualEntry ? "Yes" : "No",
      e.isApproved ? "Yes" : "No",
    ].join(","),
  );

  const csv = header + rows.join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="timesheets-${from}-to-${to}.csv"`);
  res.send(csv);
});

// ─── OVERTIME RULES ───────────────────────────────────────────────────────────

router.get("/overtime-rules", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const rules = await db.select().from(overtimeRulesTable).where(eq(overtimeRulesTable.organizationId, orgId)).orderBy(desc(overtimeRulesTable.createdAt));
  res.json(rules);
});

router.post("/overtime-rules", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { name, regularHoursPerDay, regularHoursPerWeek, overtimeMultiplier, doubleTimeMultiplier, weekendPenaltyMultiplier, publicHolidayMultiplier } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [rule] = await db.insert(overtimeRulesTable).values({
    organizationId: orgId,
    name,
    regularHoursPerDay: regularHoursPerDay ? String(regularHoursPerDay) : "8",
    regularHoursPerWeek: regularHoursPerWeek ? String(regularHoursPerWeek) : "40",
    overtimeMultiplier: overtimeMultiplier ? String(overtimeMultiplier) : "1.5",
    doubleTimeMultiplier: doubleTimeMultiplier ? String(doubleTimeMultiplier) : "2.0",
    weekendPenaltyMultiplier: weekendPenaltyMultiplier ? String(weekendPenaltyMultiplier) : "1.25",
    publicHolidayMultiplier: publicHolidayMultiplier ? String(publicHolidayMultiplier) : "2.5",
  }).returning();

  res.status(201).json(rule);
});

router.patch("/overtime-rules/:ruleId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const numericFields = ["regularHoursPerDay", "regularHoursPerWeek", "overtimeMultiplier", "doubleTimeMultiplier", "weekendPenaltyMultiplier", "publicHolidayMultiplier"];
  for (const field of numericFields) {
    if (field in req.body) updates[field] = String(req.body[field]);
  }
  if ("name" in req.body) updates.name = req.body.name;
  if ("isActive" in req.body) updates.isActive = req.body.isActive;

  const [updated] = await db.update(overtimeRulesTable).set(updates).where(and(eq(overtimeRulesTable.id, ruleId), eq(overtimeRulesTable.organizationId, orgId))).returning();
  if (!updated) { { res.status(404).json({ error: "Rule not found" }); return; } }
  res.json(updated);
});

// ─── MY SCHEDULES (staff portal) ──────────────────────────────────────────────

router.get("/my-shifts", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const staffProfile = await getStaffProfileForUser(user.id, orgId);
  if (!staffProfile) { { res.json([]); return; } }

  const { from, to } = req.query;
  const conditions = [
    eq(shiftsTable.organizationId, orgId),
    eq(shiftsTable.staffProfileId, staffProfile.id),
  ];
  if (from) conditions.push(gte(shiftsTable.date, String(from)));
  if (to) conditions.push(lte(shiftsTable.date, String(to)));

  const shifts = await db.select().from(shiftsTable).where(and(...conditions)).orderBy(shiftsTable.date, shiftsTable.startTime);
  res.json(shifts);
});

router.get("/my-leave", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const staffProfile = await getStaffProfileForUser(user.id, orgId);
  if (!staffProfile) { { res.json({ requests: [], annualBalance: 0, sickBalance: 0 }); return; } }

  const requests = await db.select().from(leaveRequestsTable).where(and(eq(leaveRequestsTable.organizationId, orgId), eq(leaveRequestsTable.staffProfileId, staffProfile.id))).orderBy(desc(leaveRequestsTable.createdAt));
  res.json({
    requests,
    annualBalance: staffProfile.annualLeaveBalance,
    sickBalance: staffProfile.sickLeaveBalance,
  });
});

router.get("/my-timesheets", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  const user = await requireAuth(req, res);
  if (!user) return;

  const staffProfile = await getStaffProfileForUser(user.id, orgId);
  if (!staffProfile) { { res.json([]); return; } }

  const { from, to } = req.query;
  const conditions = [
    eq(timesheetEntriesTable.organizationId, orgId),
    eq(timesheetEntriesTable.staffProfileId, staffProfile.id),
  ];
  if (from) conditions.push(gte(timesheetEntriesTable.date, String(from)));
  if (to) conditions.push(lte(timesheetEntriesTable.date, String(to)));

  const entries = await db.select().from(timesheetEntriesTable).where(and(...conditions)).orderBy(desc(timesheetEntriesTable.date));
  res.json(entries);
});

export default router;
