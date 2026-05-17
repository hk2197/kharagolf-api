import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  lockersTable, lockerAssignmentsTable, lockerWaitlistTable, lockerAuditTable,
  clubMembersTable, appUsersTable, orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, asc, ne, inArray, sql } from "drizzle-orm";
import { getRazorpayClient, getRazorpayKeyId, type RazorpayPaymentLinkCreateOpts, type RazorpayExtended } from "../lib/razorpay";
import { sendLockerRenewalReminderEmail } from "../lib/mailer";
import { sendTransactionalPush } from "../lib/comms";
import { gateFeature } from "../lib/featureGate";

const router: IRouter = Router({ mergeParams: true });
router.use(gateFeature("shopLockerAccess"));

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

// ─── LOCKERS CRUD ─────────────────────────────────────────────────────────────

// GET /organizations/:orgId/lockers
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const lockers = await db
    .select({
      id: lockersTable.id,
      lockerNumber: lockersTable.lockerNumber,
      bay: lockersTable.bay,
      row: lockersTable.row,
      column: lockersTable.column,
      status: lockersTable.status,
      annualFee: lockersTable.annualFee,
      currency: lockersTable.currency,
      notes: lockersTable.notes,
      createdAt: lockersTable.createdAt,
      updatedAt: lockersTable.updatedAt,
    })
    .from(lockersTable)
    .where(eq(lockersTable.organizationId, orgId))
    .orderBy(asc(lockersTable.bay), asc(lockersTable.row), asc(lockersTable.column), asc(lockersTable.lockerNumber));

  const lockerIds = lockers.map(l => l.id);
  let activeAssignments: Array<{
    lockerId: number;
    assignmentId: number;
    memberId: number;
    firstName: string;
    lastName: string;
    memberNumber: string | null;
    expiryDate: Date;
    paymentStatus: string;
    status: string;
  }> = [];

  if (lockerIds.length > 0) {
    activeAssignments = await db
      .select({
        lockerId: lockerAssignmentsTable.lockerId,
        assignmentId: lockerAssignmentsTable.id,
        memberId: lockerAssignmentsTable.memberId,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        memberNumber: clubMembersTable.memberNumber,
        expiryDate: lockerAssignmentsTable.expiryDate,
        paymentStatus: lockerAssignmentsTable.paymentStatus,
        status: lockerAssignmentsTable.status,
      })
      .from(lockerAssignmentsTable)
      .innerJoin(clubMembersTable, eq(clubMembersTable.id, lockerAssignmentsTable.memberId))
      .where(and(
        inArray(lockerAssignmentsTable.lockerId, lockerIds),
        eq(lockerAssignmentsTable.status, "active"),
      ));
  }

  const assignmentMap = new Map<number, (typeof activeAssignments)[0]>();
  for (const a of activeAssignments) assignmentMap.set(a.lockerId, a);

  res.json(lockers.map(l => ({
    ...l,
    assignment: assignmentMap.get(l.id) ?? null,
  })));
});

// POST /organizations/:orgId/lockers
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { lockerNumber, bay, row, column, annualFee, currency, notes } = req.body;
  if (!lockerNumber) { { res.status(400).json({ error: "lockerNumber is required" }); return; } }

  const [locker] = await db.insert(lockersTable).values({
    organizationId: orgId,
    lockerNumber: String(lockerNumber),
    bay: bay ?? null,
    row: row != null ? parseInt(row) : null,
    column: column != null ? parseInt(column) : null,
    annualFee: annualFee ? String(annualFee) : "0",
    currency: currency ?? "INR",
    notes: notes ?? null,
  }).returning();

  res.status(201).json(locker);
});

// PUT /organizations/:orgId/lockers/:lockerId
router.put("/:lockerId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Locker not found" }); return; } }

  const { lockerNumber, bay, row, column, status, annualFee, currency, notes } = req.body;
  const [updated] = await db.update(lockersTable).set({
    lockerNumber: lockerNumber ?? existing.lockerNumber,
    bay: bay !== undefined ? bay : existing.bay,
    row: row !== undefined ? parseInt(row) : existing.row,
    column: column !== undefined ? parseInt(column) : existing.column,
    status: status ?? existing.status,
    annualFee: annualFee !== undefined ? String(annualFee) : existing.annualFee,
    currency: currency ?? existing.currency,
    notes: notes !== undefined ? notes : existing.notes,
    updatedAt: new Date(),
  }).where(eq(lockersTable.id, lockerId)).returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/lockers/:lockerId
router.delete("/:lockerId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Locker not found" }); return; } }

  const [active] = await db.select({ id: lockerAssignmentsTable.id }).from(lockerAssignmentsTable)
    .where(and(eq(lockerAssignmentsTable.lockerId, lockerId), eq(lockerAssignmentsTable.status, "active")));
  if (active) { { res.status(400).json({ error: "Cannot delete locker with active assignment. Reassign or cancel first." }); return; } }

  await db.delete(lockersTable).where(eq(lockersTable.id, lockerId));
  res.json({ success: true });
});

// ─── ASSIGNMENTS ──────────────────────────────────────────────────────────────

// GET /organizations/:orgId/lockers/assignments
router.get("/assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const assignments = await db
    .select({
      id: lockerAssignmentsTable.id,
      lockerId: lockerAssignmentsTable.lockerId,
      lockerNumber: lockersTable.lockerNumber,
      bay: lockersTable.bay,
      memberId: lockerAssignmentsTable.memberId,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      memberNumber: clubMembersTable.memberNumber,
      email: clubMembersTable.email,
      startDate: lockerAssignmentsTable.startDate,
      expiryDate: lockerAssignmentsTable.expiryDate,
      status: lockerAssignmentsTable.status,
      annualFee: lockerAssignmentsTable.annualFee,
      currency: lockerAssignmentsTable.currency,
      paymentMethod: lockerAssignmentsTable.paymentMethod,
      paymentStatus: lockerAssignmentsTable.paymentStatus,
      paymentLinkUrl: lockerAssignmentsTable.paymentLinkUrl,
      notes: lockerAssignmentsTable.notes,
      createdAt: lockerAssignmentsTable.createdAt,
    })
    .from(lockerAssignmentsTable)
    .innerJoin(lockersTable, eq(lockersTable.id, lockerAssignmentsTable.lockerId))
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, lockerAssignmentsTable.memberId))
    .where(eq(lockerAssignmentsTable.organizationId, orgId))
    .orderBy(desc(lockerAssignmentsTable.createdAt));

  res.json(assignments);
});

// POST /organizations/:orgId/lockers/:lockerId/assign
router.post("/:lockerId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [locker] = await db.select().from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!locker) { { res.status(404).json({ error: "Locker not found" }); return; } }
  if (locker.status === "maintenance") { { res.status(400).json({ error: "Locker is under maintenance" }); return; } }

  const [activeAssignment] = await db.select({ id: lockerAssignmentsTable.id }).from(lockerAssignmentsTable)
    .where(and(eq(lockerAssignmentsTable.lockerId, lockerId), eq(lockerAssignmentsTable.status, "active")));
  if (activeAssignment) { { res.status(400).json({ error: "Locker is already assigned. Reassign or cancel current assignment first." }); return; } }

  const { memberId, startDate, expiryDate, annualFee, paymentMethod, notes } = req.body;
  if (!memberId || !startDate || !expiryDate) {
    res.status(400).json({ error: "memberId, startDate, and expiryDate are required" });
    return;
  }

  const [member] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, parseInt(memberId)), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Club member not found" }); return; } }

  const adminUser = req.user as { id: number };
  const fee = annualFee !== undefined ? String(annualFee) : locker.annualFee;
  const method = paymentMethod ?? "account_charge";

  let assignment: typeof lockerAssignmentsTable.$inferSelect;
  try {
    [assignment] = await db.transaction(async (tx) => {
      const [conflict] = await tx.select({ id: lockerAssignmentsTable.id }).from(lockerAssignmentsTable)
        .where(and(eq(lockerAssignmentsTable.lockerId, lockerId), eq(lockerAssignmentsTable.status, "active")));
      if (conflict) throw Object.assign(new Error("Locker is already assigned"), { status: 409 });

      const [newAssignment] = await tx.insert(lockerAssignmentsTable).values({
        lockerId,
        organizationId: orgId,
        memberId: parseInt(memberId),
        startDate: new Date(startDate),
        expiryDate: new Date(expiryDate),
        status: "active",
        annualFee: fee,
        currency: locker.currency,
        paymentMethod: method,
        paymentStatus: method === "account_charge" ? "paid" : "unpaid",
        assignedBy: adminUser.id,
        notes: notes ?? null,
      }).returning();

      await tx.update(lockersTable).set({ status: "occupied", updatedAt: new Date() })
        .where(eq(lockersTable.id, lockerId));

      await tx.insert(lockerAuditTable).values({
        lockerId,
        organizationId: orgId,
        action: "assigned",
        previousMemberId: null,
        newMemberId: parseInt(memberId),
        performedBy: adminUser.id,
        reason: notes ?? null,
      });

      return [newAssignment];
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 409) { { res.status(409).json({ error: "Locker is already assigned. Reassign or cancel current assignment first." }); return; } }
    throw err;
  }

  if (method === "razorpay" && parseFloat(fee) > 0) {
    try {
      const razorpay: RazorpayExtended = getRazorpayClient();
      const keyId = getRazorpayKeyId();
      if (razorpay && keyId) {
        const linkOpts: RazorpayPaymentLinkCreateOpts = {
          amount: Math.round(parseFloat(fee) * 100),
          currency: locker.currency,
          description: `Locker ${locker.lockerNumber} rental`,
          customer: {
            name: `${member.firstName} ${member.lastName}`,
            email: member.email ?? undefined,
            contact: member.phone ?? undefined,
          },
          notify: { email: true, sms: false },
          reminder_enable: true,
          reference_id: `locker-${assignment.id}`,
          notes: { lockerAssignmentId: String(assignment.id), orgId: String(orgId) },
        };
        const link = await razorpay.paymentLink.create(linkOpts);
        await db.update(lockerAssignmentsTable).set({
          paymentLinkId: link.id,
          paymentLinkUrl: link.short_url,
          updatedAt: new Date(),
        }).where(eq(lockerAssignmentsTable.id, assignment.id));
        assignment.paymentLinkUrl = link.short_url;
      }
    } catch (err) {
      console.error("[LOCKERS] Razorpay link creation failed:", err);
    }
  }

  await db.delete(lockerWaitlistTable)
    .where(and(eq(lockerWaitlistTable.organizationId, orgId), eq(lockerWaitlistTable.memberId, parseInt(memberId))));

  res.status(201).json(assignment);
});

// POST /organizations/:orgId/lockers/:lockerId/reassign
router.post("/:lockerId/reassign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [locker] = await db.select().from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!locker) { { res.status(404).json({ error: "Locker not found" }); return; } }

  const [currentAssignment] = await db.select().from(lockerAssignmentsTable)
    .where(and(eq(lockerAssignmentsTable.lockerId, lockerId), eq(lockerAssignmentsTable.status, "active")));

  const { memberId, startDate, expiryDate, annualFee, paymentMethod, reason, notes } = req.body;
  if (!memberId || !startDate || !expiryDate) {
    res.status(400).json({ error: "memberId, startDate, and expiryDate are required" });
    return;
  }

  const [member] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, parseInt(memberId)), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Club member not found" }); return; } }

  const adminUser = req.user as { id: number };

  if (currentAssignment) {
    await db.update(lockerAssignmentsTable).set({
      status: "cancelled",
      reassignedAt: new Date(),
      reassignedReason: reason ?? null,
      updatedAt: new Date(),
    }).where(eq(lockerAssignmentsTable.id, currentAssignment.id));
  }

  const fee = annualFee !== undefined ? String(annualFee) : locker.annualFee;
  const method = paymentMethod ?? "account_charge";

  const [newAssignment] = await db.insert(lockerAssignmentsTable).values({
    lockerId,
    organizationId: orgId,
    memberId: parseInt(memberId),
    startDate: new Date(startDate),
    expiryDate: new Date(expiryDate),
    status: "active",
    annualFee: fee,
    currency: locker.currency,
    paymentMethod: method,
    paymentStatus: method === "account_charge" ? "paid" : "unpaid",
    assignedBy: adminUser.id,
    notes: notes ?? null,
  }).returning();

  await db.insert(lockerAuditTable).values({
    lockerId,
    organizationId: orgId,
    action: "reassigned",
    previousMemberId: currentAssignment?.memberId ?? null,
    newMemberId: parseInt(memberId),
    performedBy: adminUser.id,
    reason: reason ?? null,
  });

  await db.delete(lockerWaitlistTable)
    .where(and(eq(lockerWaitlistTable.organizationId, orgId), eq(lockerWaitlistTable.memberId, parseInt(memberId))));

  res.status(201).json(newAssignment);
});

// POST /organizations/:orgId/lockers/:lockerId/release
router.post("/:lockerId/release", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [locker] = await db.select({ id: lockersTable.id }).from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!locker) { { res.status(404).json({ error: "Locker not found" }); return; } }

  const [assignment] = await db.select().from(lockerAssignmentsTable)
    .where(and(
      eq(lockerAssignmentsTable.lockerId, lockerId),
      eq(lockerAssignmentsTable.organizationId, orgId),
      eq(lockerAssignmentsTable.status, "active"),
    ));
  if (!assignment) { { res.status(404).json({ error: "No active assignment found for this locker" }); return; } }

  const { reason } = req.body;
  const adminUser = req.user as { id: number };

  await db.update(lockerAssignmentsTable).set({
    status: "cancelled",
    reassignedAt: new Date(),
    reassignedReason: reason ?? null,
    updatedAt: new Date(),
  }).where(and(eq(lockerAssignmentsTable.id, assignment.id), eq(lockerAssignmentsTable.organizationId, orgId)));

  await db.update(lockersTable).set({ status: "available", updatedAt: new Date() })
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));

  await db.insert(lockerAuditTable).values({
    lockerId,
    organizationId: orgId,
    action: "released",
    previousMemberId: assignment.memberId,
    newMemberId: null,
    performedBy: adminUser.id,
    reason: reason ?? null,
  });

  await notifyWaitlistHead(orgId, lockerId, adminUser.id);

  res.json({ success: true });
});

// POST /organizations/:orgId/lockers/:lockerId/renew
router.post("/:lockerId/renew", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [locker] = await db.select().from(lockersTable)
    .where(and(eq(lockersTable.id, lockerId), eq(lockersTable.organizationId, orgId)));
  if (!locker) { { res.status(404).json({ error: "Locker not found" }); return; } }

  const [assignment] = await db.select().from(lockerAssignmentsTable)
    .where(and(
      eq(lockerAssignmentsTable.lockerId, lockerId),
      eq(lockerAssignmentsTable.organizationId, orgId),
      eq(lockerAssignmentsTable.status, "active"),
    ));
  if (!assignment) { { res.status(404).json({ error: "No active assignment found" }); return; } }

  const { expiryDate, annualFee, paymentMethod } = req.body;
  if (!expiryDate) { { res.status(400).json({ error: "expiryDate is required" }); return; } }

  const fee = annualFee !== undefined ? String(annualFee) : assignment.annualFee;
  const method = paymentMethod ?? assignment.paymentMethod;

  const [member] = await db.select().from(clubMembersTable)
    .where(eq(clubMembersTable.id, assignment.memberId));

  const [updated] = await db.update(lockerAssignmentsTable).set({
    expiryDate: new Date(expiryDate),
    annualFee: fee,
    paymentMethod: method,
    paymentStatus: method === "account_charge" ? "paid" : "unpaid",
    razorpayOrderId: null,
    razorpayPaymentId: null,
    paymentLinkId: null,
    paymentLinkUrl: null,
    reminder30SentAt: null,
    reminder7SentAt: null,
    updatedAt: new Date(),
  }).where(eq(lockerAssignmentsTable.id, assignment.id)).returning();

  if (method === "razorpay" && member && parseFloat(fee) > 0) {
    try {
      const razorpay: RazorpayExtended = getRazorpayClient();
      const keyId = getRazorpayKeyId();
      if (razorpay && keyId) {
        const linkOpts: RazorpayPaymentLinkCreateOpts = {
          amount: Math.round(parseFloat(fee) * 100),
          currency: locker.currency,
          description: `Locker ${locker.lockerNumber} renewal`,
          customer: {
            name: `${member.firstName} ${member.lastName}`,
            email: member.email ?? undefined,
            contact: member.phone ?? undefined,
          },
          notify: { email: true, sms: false },
          reminder_enable: true,
          reference_id: `locker-renewal-${assignment.id}`,
          notes: { lockerAssignmentId: String(assignment.id), orgId: String(orgId) },
        };
        const link = await razorpay.paymentLink.create(linkOpts);
        await db.update(lockerAssignmentsTable).set({
          paymentLinkId: link.id,
          paymentLinkUrl: link.short_url,
          updatedAt: new Date(),
        }).where(eq(lockerAssignmentsTable.id, assignment.id));
        updated.paymentLinkUrl = link.short_url;
      }
    } catch (err) {
      console.error("[LOCKERS] Razorpay renewal link creation failed:", err);
    }
  }

  await db.insert(lockerAuditTable).values({
    lockerId,
    organizationId: orgId,
    action: "renewed",
    previousMemberId: assignment.memberId,
    newMemberId: assignment.memberId,
    performedBy: (req.user as { id: number }).id,
    reason: `Renewed until ${expiryDate}`,
  });

  res.json(updated);
});

// GET /organizations/:orgId/lockers/:lockerId/audit
router.get("/:lockerId/audit", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const lockerId = parseInt(String((req.params as Record<string, string>).lockerId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const audit = await db
    .select({
      id: lockerAuditTable.id,
      action: lockerAuditTable.action,
      reason: lockerAuditTable.reason,
      previousMemberId: lockerAuditTable.previousMemberId,
      newMemberId: lockerAuditTable.newMemberId,
      performedBy: lockerAuditTable.performedBy,
      createdAt: lockerAuditTable.createdAt,
    })
    .from(lockerAuditTable)
    .where(and(eq(lockerAuditTable.lockerId, lockerId), eq(lockerAuditTable.organizationId, orgId)))
    .orderBy(desc(lockerAuditTable.createdAt));

  const memberIds = [...new Set([
    ...audit.map(a => a.previousMemberId).filter(Boolean),
    ...audit.map(a => a.newMemberId).filter(Boolean),
  ])] as number[];
  const userIds = audit.map(a => a.performedBy).filter(Boolean) as number[];

  const members = memberIds.length > 0
    ? await db.select({ id: clubMembersTable.id, firstName: clubMembersTable.firstName, lastName: clubMembersTable.lastName }).from(clubMembersTable).where(inArray(clubMembersTable.id, memberIds))
    : [];
  const users = userIds.length > 0
    ? await db.select({ id: appUsersTable.id, displayName: appUsersTable.displayName, username: appUsersTable.username }).from(appUsersTable).where(inArray(appUsersTable.id, userIds))
    : [];

  const memberMap = new Map(members.map(m => [m.id, m]));
  const userMap = new Map(users.map(u => [u.id, u]));

  res.json(audit.map(a => ({
    ...a,
    previousMember: a.previousMemberId ? memberMap.get(a.previousMemberId) ?? null : null,
    newMember: a.newMemberId ? memberMap.get(a.newMemberId) ?? null : null,
    performedByUser: a.performedBy ? userMap.get(a.performedBy) ?? null : null,
  })));
});

// ─── WAITLIST ─────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/lockers/waitlist
router.get("/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const waitlist = await db
    .select({
      id: lockerWaitlistTable.id,
      memberId: lockerWaitlistTable.memberId,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      memberNumber: clubMembersTable.memberNumber,
      email: clubMembersTable.email,
      requestedAt: lockerWaitlistTable.requestedAt,
      notifiedAt: lockerWaitlistTable.notifiedAt,
      status: lockerWaitlistTable.status,
      notes: lockerWaitlistTable.notes,
    })
    .from(lockerWaitlistTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, lockerWaitlistTable.memberId))
    .where(eq(lockerWaitlistTable.organizationId, orgId))
    .orderBy(asc(lockerWaitlistTable.requestedAt));

  res.json(waitlist);
});

// POST /organizations/:orgId/lockers/waitlist
// Admins can pass memberId to add any member; non-admins are added as themselves (memberId ignored)
router.post("/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const sessionUser = req.user as { id: number; role?: string; organizationId?: number };
  const { notes } = req.body;

  const isAdmin = sessionUser.role === "super_admin"
    || ((sessionUser.role === "org_admin" || sessionUser.role === "tournament_director") && Number(sessionUser.organizationId) === orgId);

  let resolvedMemberId: number;

  if (isAdmin && req.body.memberId) {
    resolvedMemberId = parseInt(req.body.memberId);
    const [adminTarget] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
      .where(and(eq(clubMembersTable.id, resolvedMemberId), eq(clubMembersTable.organizationId, orgId)));
    if (!adminTarget) { { res.status(404).json({ error: "Club member not found" }); return; } }
  } else {
    const [selfMember] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
      .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, sessionUser.id)));
    if (!selfMember) { { res.status(403).json({ error: "No club membership found for your account in this organization" }); return; } }
    resolvedMemberId = selfMember.id;
  }

  const [entry] = await db.insert(lockerWaitlistTable).values({
    organizationId: orgId,
    memberId: resolvedMemberId,
    notes: notes ?? null,
  }).onConflictDoNothing().returning();

  if (!entry) { { res.status(409).json({ error: "Member is already on the waitlist" }); return; } }

  res.status(201).json(entry);
});

// DELETE /organizations/:orgId/lockers/waitlist/:entryId
router.delete("/waitlist/:entryId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const entryId = parseInt(String((req.params as Record<string, string>).entryId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(lockerWaitlistTable)
    .where(and(eq(lockerWaitlistTable.id, entryId), eq(lockerWaitlistTable.organizationId, orgId)));

  res.json({ success: true });
});

// ─── MEMBER PORTAL ────────────────────────────────────────────────────────────

// GET /organizations/:orgId/lockers/my-locker (player self-service)
router.get("/my-locker", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const userId = (req.user as { id: number }).id;

  const [member] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, userId)));

  if (!member) { { res.json(null); return; } }

  const [assignment] = await db
    .select({
      id: lockerAssignmentsTable.id,
      lockerNumber: lockersTable.lockerNumber,
      bay: lockersTable.bay,
      expiryDate: lockerAssignmentsTable.expiryDate,
      startDate: lockerAssignmentsTable.startDate,
      status: lockerAssignmentsTable.status,
      annualFee: lockerAssignmentsTable.annualFee,
      currency: lockerAssignmentsTable.currency,
      paymentStatus: lockerAssignmentsTable.paymentStatus,
      paymentLinkUrl: lockerAssignmentsTable.paymentLinkUrl,
    })
    .from(lockerAssignmentsTable)
    .innerJoin(lockersTable, eq(lockersTable.id, lockerAssignmentsTable.lockerId))
    .where(and(
      eq(lockerAssignmentsTable.memberId, member.id),
      eq(lockerAssignmentsTable.status, "active"),
    ))
    .orderBy(desc(lockerAssignmentsTable.createdAt))
    .limit(1);

  const [waitlistEntry] = await db.select({ id: lockerWaitlistTable.id, requestedAt: lockerWaitlistTable.requestedAt, status: lockerWaitlistTable.status }).from(lockerWaitlistTable)
    .where(and(eq(lockerWaitlistTable.organizationId, orgId), eq(lockerWaitlistTable.memberId, member.id)));

  res.json({
    assignment: assignment ?? null,
    waitlistEntry: waitlistEntry ?? null,
  });
});

// ─── BULK RENEWAL ─────────────────────────────────────────────────────────────

// POST /organizations/:orgId/lockers/bulk-renew
router.post("/bulk-renew", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { assignmentIds, newExpiryDate, annualFee, paymentMethod } = req.body;
  if (!Array.isArray(assignmentIds) || !newExpiryDate) {
    res.status(400).json({ error: "assignmentIds array and newExpiryDate are required" });
    return;
  }

  const adminUser = req.user as { id: number };
  const results: Array<{ id: number; success: boolean; error?: string }> = [];

  for (const id of assignmentIds) {
    try {
      const [assignment] = await db.select().from(lockerAssignmentsTable)
        .where(and(eq(lockerAssignmentsTable.id, id), eq(lockerAssignmentsTable.organizationId, orgId)));
      if (!assignment || assignment.status !== "active") {
        results.push({ id, success: false, error: "Assignment not found or not active" });
        continue;
      }

      const method = paymentMethod ?? assignment.paymentMethod;
      const fee = annualFee !== undefined ? String(annualFee) : assignment.annualFee;

      await db.update(lockerAssignmentsTable).set({
        expiryDate: new Date(newExpiryDate),
        annualFee: fee,
        paymentMethod: method,
        paymentStatus: method === "account_charge" ? "paid" : "unpaid",
        paymentLinkId: null,
        paymentLinkUrl: null,
        reminder30SentAt: null,
        reminder7SentAt: null,
        updatedAt: new Date(),
      }).where(eq(lockerAssignmentsTable.id, id));

      if (method === "razorpay" && parseFloat(fee) > 0) {
        try {
          const razorpay: RazorpayExtended = getRazorpayClient();
          const [locker] = await db.select().from(lockersTable).where(eq(lockersTable.id, assignment.lockerId));
          const [member] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, assignment.memberId));
          if (razorpay && locker && member) {
            const linkOpts: RazorpayPaymentLinkCreateOpts = {
              amount: Math.round(parseFloat(fee) * 100),
              currency: locker.currency,
              description: `Locker ${locker.lockerNumber} bulk renewal`,
              customer: {
                name: `${member.firstName} ${member.lastName}`,
                email: member.email ?? undefined,
                contact: member.phone ?? undefined,
              },
              notify: { email: true, sms: false },
              reminder_enable: true,
              reference_id: `locker-bulk-${id}`,
              notes: { lockerAssignmentId: String(id), orgId: String(orgId) },
            };
            const link = await razorpay.paymentLink.create(linkOpts);
            await db.update(lockerAssignmentsTable).set({
              paymentLinkId: link.id,
              paymentLinkUrl: link.short_url,
              updatedAt: new Date(),
            }).where(eq(lockerAssignmentsTable.id, id));
          }
        } catch (rzErr) {
          console.error(`[LOCKERS] Bulk renew Razorpay link failed for assignment ${id}:`, rzErr);
        }
      }

      await db.insert(lockerAuditTable).values({
        lockerId: assignment.lockerId,
        organizationId: orgId,
        action: "bulk_renewed",
        previousMemberId: assignment.memberId,
        newMemberId: assignment.memberId,
        performedBy: adminUser.id,
        reason: `Bulk renewed until ${newExpiryDate}`,
      });

      results.push({ id, success: true });
    } catch (err) {
      results.push({ id, success: false, error: String(err) });
    }
  }

  res.json({ results });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function notifyWaitlistHead(orgId: number, lockerId: number, adminId: number) {
  try {
    let member: typeof clubMembersTable.$inferSelect | undefined;
    let lockerNumber: string | undefined;

    await db.transaction(async (tx) => {
      const [head] = await tx
        .select({ id: lockerWaitlistTable.id, memberId: lockerWaitlistTable.memberId })
        .from(lockerWaitlistTable)
        .where(and(eq(lockerWaitlistTable.organizationId, orgId), eq(lockerWaitlistTable.status, "waiting")))
        .orderBy(asc(lockerWaitlistTable.requestedAt))
        .limit(1);

      if (!head) return;

      const [m] = await tx.select().from(clubMembersTable).where(eq(clubMembersTable.id, head.memberId));
      if (!m) return;
      member = m;

      const [locker] = await tx.select().from(lockersTable).where(eq(lockersTable.id, lockerId));

      if (locker) {
        lockerNumber = locker.lockerNumber;
        const now = new Date();
        const expiryDate = new Date(now);
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);

        await tx.insert(lockerAssignmentsTable).values({
          lockerId,
          organizationId: orgId,
          memberId: head.memberId,
          startDate: now,
          expiryDate,
          status: "active",
          annualFee: locker.annualFee,
          currency: locker.currency,
          paymentMethod: "account_charge",
          paymentStatus: "unpaid",
          assignedBy: adminId,
          notes: "Auto-promoted from waitlist",
        });

        await tx.update(lockersTable).set({ status: "occupied", updatedAt: now }).where(eq(lockersTable.id, lockerId));

        await tx.insert(lockerAuditTable).values({
          lockerId,
          organizationId: orgId,
          action: "auto_promoted",
          previousMemberId: null,
          newMemberId: head.memberId,
          performedBy: adminId,
          reason: "Auto-promoted from waitlist on locker release",
        });
      }

      await tx.update(lockerWaitlistTable).set({ notifiedAt: new Date(), status: "notified" }).where(eq(lockerWaitlistTable.id, head.id));
    });

    if (!member) return;

    if (member.userId) {
      // Task #1240 — fire-and-forget: PushDeliveryResult is discarded; the
      // outer try/catch handles thrown errors. No `classifyPushDelivery`
      // mapping needed because the email below + on-screen banner in the
      // member's profile are the durable signals that the locker was
      // auto-assigned.
      await sendTransactionalPush(
        [member.userId],
        "Locker Assigned",
        `Locker ${lockerNumber ?? ""} has been automatically assigned to you. Please contact the club office to confirm and complete payment.`,
        { type: "locker_auto_assigned" },
      );
    }

    if (member.email) {
      try {
        await sendLockerRenewalReminderEmail(member.email, `${member.firstName} ${member.lastName}`, "available");
      } catch (e) {
        console.error("[LOCKERS] Waitlist email failed:", e);
      }
    }
  } catch (err) {
    console.error("[LOCKERS] notifyWaitlistHead error:", err);
  }
}

export default router;
