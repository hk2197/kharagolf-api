import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import {
  membershipApplicationsTable,
  applicationNotesTable,
  membershipTiersTable,
  clubMembersTable,
  organizationsTable,
  orgMembershipsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, and, desc, count, sql, inArray } from "drizzle-orm";
import {
  sendApplicationReceivedEmail,
  sendApplicationStageChangeEmail,
  sendApplicationApprovedEmail,
  sendApplicationRejectedEmail,
} from "../lib/mailer";

const router: IRouter = Router({ mergeParams: true });

function getOrigin(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto") ?? (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

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

function generateReferenceCode(): string {
  return "APP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ─── PUBLIC ENDPOINTS ─────────────────────────────────────────────────────────

// GET /public/organizations/:orgSlug/apply — fetch org info + membership tiers for the public form
router.get("/public/organizations/:orgSlug/apply", async (req: Request, res: Response) => {
  const { orgSlug } = (req.params as Record<string, string>);
  const [org] = await db.select({
    id: organizationsTable.id,
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    description: organizationsTable.description,
  }).from(organizationsTable).where(eq(organizationsTable.slug, orgSlug));

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const tiers = await db.select({
    id: membershipTiersTable.id,
    name: membershipTiersTable.name,
    description: membershipTiersTable.description,
    annualFee: membershipTiersTable.annualFee,
    currency: membershipTiersTable.currency,
  }).from(membershipTiersTable)
    .where(and(
      eq(membershipTiersTable.organizationId, org.id),
      eq(membershipTiersTable.isActive, true),
    ));

  res.json({ org, tiers });
});

// POST /public/organizations/:orgSlug/apply — submit a membership application
router.post("/public/organizations/:orgSlug/apply", async (req: Request, res: Response) => {
  const { orgSlug } = (req.params as Record<string, string>);
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.slug, orgSlug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const {
    firstName, lastName, email, phone, dateOfBirth, address,
    golfBackground, currentHandicap, previousClub, yearsPlaying,
    proposerName, proposerMemberNumber, seconderName, seconderMemberNumber,
    tierId,
  } = req.body;

  if (!firstName || !lastName || !email) {
    res.status(400).json({ error: "firstName, lastName, and email are required" });
    return;
  }

  // Prevent duplicate active applications from the same email+org
  const existing = await db.select({ id: membershipApplicationsTable.id })
    .from(membershipApplicationsTable)
    .where(and(
      eq(membershipApplicationsTable.organizationId, org.id),
      eq(membershipApplicationsTable.email, email.toLowerCase().trim()),
      inArray(membershipApplicationsTable.stage, ["applied", "under_review", "pending_committee"]),
    ));
  if (existing.length > 0) {
    res.status(409).json({ error: "An active application already exists for this email address." });
    return;
  }

  const referenceCode = generateReferenceCode();

  const [app] = await db.insert(membershipApplicationsTable).values({
    organizationId: org.id,
    tierId: tierId ? Number(tierId) : null,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.toLowerCase().trim(),
    phone: phone?.trim() ?? null,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
    address: address?.trim() ?? null,
    golfBackground: golfBackground?.trim() ?? null,
    currentHandicap: currentHandicap != null ? String(currentHandicap) : null,
    previousClub: previousClub?.trim() ?? null,
    yearsPlaying: yearsPlaying ? Number(yearsPlaying) : null,
    proposerName: proposerName?.trim() ?? null,
    proposerMemberNumber: proposerMemberNumber?.trim() ?? null,
    seconderName: seconderName?.trim() ?? null,
    seconderMemberNumber: seconderMemberNumber?.trim() ?? null,
    referenceCode,
    stage: "applied",
    stageUpdatedAt: new Date(),
  }).returning();

  // Send confirmation email (fire-and-forget)
  if (app.email) {
    const branding = { orgName: org.name, logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined };
    sendApplicationReceivedEmail(app.email, `${app.firstName} ${app.lastName}`, org.name, referenceCode, branding).catch(() => {});
  }

  res.status(201).json({ id: app.id, referenceCode: app.referenceCode, stage: app.stage });
});

// ─── ADMIN ENDPOINTS ──────────────────────────────────────────────────────────

// GET /organizations/:orgId/waitlist — list applications with dashboard stats
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { stage, search } = req.query as { stage?: string; search?: string };

  let query = db.select({
    id: membershipApplicationsTable.id,
    referenceCode: membershipApplicationsTable.referenceCode,
    firstName: membershipApplicationsTable.firstName,
    lastName: membershipApplicationsTable.lastName,
    email: membershipApplicationsTable.email,
    phone: membershipApplicationsTable.phone,
    stage: membershipApplicationsTable.stage,
    stageUpdatedAt: membershipApplicationsTable.stageUpdatedAt,
    submittedAt: membershipApplicationsTable.submittedAt,
    tierId: membershipApplicationsTable.tierId,
    tierName: membershipTiersTable.name,
    currentHandicap: membershipApplicationsTable.currentHandicap,
    previousClub: membershipApplicationsTable.previousClub,
    createdMemberId: membershipApplicationsTable.createdMemberId,
    adminNotes: membershipApplicationsTable.adminNotes,
    rejectionReason: membershipApplicationsTable.rejectionReason,
  }).from(membershipApplicationsTable)
    .leftJoin(membershipTiersTable, eq(membershipApplicationsTable.tierId, membershipTiersTable.id))
    .where(eq(membershipApplicationsTable.organizationId, orgId))
    .$dynamic();

  const apps = await query.orderBy(desc(membershipApplicationsTable.submittedAt));

  let filtered = apps;
  if (stage) {
    filtered = filtered.filter(a => a.stage === stage);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(a =>
      a.firstName.toLowerCase().includes(q) ||
      a.lastName.toLowerCase().includes(q) ||
      (a.email?.toLowerCase().includes(q)) ||
      a.referenceCode.toLowerCase().includes(q),
    );
  }

  // Compute stage counts
  const stageCounts = await db.select({
    stage: membershipApplicationsTable.stage,
    count: count(),
  }).from(membershipApplicationsTable)
    .where(eq(membershipApplicationsTable.organizationId, orgId))
    .groupBy(membershipApplicationsTable.stage);

  // Average wait time (days from submitted to stageUpdatedAt for approved/rejected)
  const avgWaitResult = await db.execute(sql`
    SELECT AVG(EXTRACT(EPOCH FROM (stage_updated_at - submitted_at)) / 86400) AS avg_days
    FROM membership_applications
    WHERE organization_id = ${orgId}
      AND stage IN ('approved', 'rejected')
  `);
  const avgWaitDays = Number((avgWaitResult.rows[0] as any)?.avg_days ?? 0);

  res.json({
    applications: filtered,
    stats: {
      stageCounts: Object.fromEntries(stageCounts.map(s => [s.stage, Number(s.count)])),
      avgWaitDays: Math.round(avgWaitDays * 10) / 10,
    },
  });
});

// GET /organizations/:orgId/waitlist/:id — get single application detail
router.get("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const appId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [app] = await db.select({
    id: membershipApplicationsTable.id,
    referenceCode: membershipApplicationsTable.referenceCode,
    firstName: membershipApplicationsTable.firstName,
    lastName: membershipApplicationsTable.lastName,
    email: membershipApplicationsTable.email,
    phone: membershipApplicationsTable.phone,
    dateOfBirth: membershipApplicationsTable.dateOfBirth,
    address: membershipApplicationsTable.address,
    golfBackground: membershipApplicationsTable.golfBackground,
    currentHandicap: membershipApplicationsTable.currentHandicap,
    previousClub: membershipApplicationsTable.previousClub,
    yearsPlaying: membershipApplicationsTable.yearsPlaying,
    proposerName: membershipApplicationsTable.proposerName,
    proposerMemberNumber: membershipApplicationsTable.proposerMemberNumber,
    seconderName: membershipApplicationsTable.seconderName,
    seconderMemberNumber: membershipApplicationsTable.seconderMemberNumber,
    stage: membershipApplicationsTable.stage,
    stageUpdatedAt: membershipApplicationsTable.stageUpdatedAt,
    submittedAt: membershipApplicationsTable.submittedAt,
    tierId: membershipApplicationsTable.tierId,
    tierName: membershipTiersTable.name,
    tierCurrency: membershipTiersTable.currency,
    tierAnnualFee: membershipTiersTable.annualFee,
    adminNotes: membershipApplicationsTable.adminNotes,
    rejectionReason: membershipApplicationsTable.rejectionReason,
    attachments: membershipApplicationsTable.attachments,
    createdMemberId: membershipApplicationsTable.createdMemberId,
  }).from(membershipApplicationsTable)
    .leftJoin(membershipTiersTable, eq(membershipApplicationsTable.tierId, membershipTiersTable.id))
    .where(and(
      eq(membershipApplicationsTable.id, appId),
      eq(membershipApplicationsTable.organizationId, orgId),
    ));

  if (!app) { { res.status(404).json({ error: "Application not found" }); return; } }

  // Fetch notes with author info
  const notes = await db.select({
    id: applicationNotesTable.id,
    body: applicationNotesTable.body,
    isInternal: applicationNotesTable.isInternal,
    createdAt: applicationNotesTable.createdAt,
    authorUsername: appUsersTable.username,
    authorDisplayName: appUsersTable.displayName,
  }).from(applicationNotesTable)
    .leftJoin(appUsersTable, eq(applicationNotesTable.authorId, appUsersTable.id))
    .where(eq(applicationNotesTable.applicationId, appId))
    .orderBy(desc(applicationNotesTable.createdAt));

  res.json({ ...app, notes });
});

// PATCH /organizations/:orgId/waitlist/:id/stage — advance stage
router.patch("/:id/stage", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const appId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { stage, rejectionReason } = req.body as { stage: string; rejectionReason?: string };
  const validStages = ["applied", "under_review", "pending_committee", "approved", "rejected"];
  if (!stage || !validStages.includes(stage)) {
    res.status(400).json({ error: `stage must be one of: ${validStages.join(", ")}` });
    return;
  }

  const [existing] = await db.select().from(membershipApplicationsTable)
    .where(and(eq(membershipApplicationsTable.id, appId), eq(membershipApplicationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Application not found" }); return; } }
  if (existing.stage === stage) { { res.json(existing); return; } }

  // APPROVED — auto-create club member
  let createdMemberId: number | null = existing.createdMemberId;
  if (stage === "approved" && !existing.createdMemberId) {
    // Generate member number
    const [lastMember] = await db.select({ memberNumber: clubMembersTable.memberNumber })
      .from(clubMembersTable)
      .where(eq(clubMembersTable.organizationId, orgId))
      .orderBy(desc(clubMembersTable.id))
      .limit(1);

    let nextNum = 1;
    if (lastMember?.memberNumber) {
      const match = lastMember.memberNumber.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const memberNumber = `MBR-${String(nextNum).padStart(4, "0")}`;

    const [newMember] = await db.insert(clubMembersTable).values({
      organizationId: orgId,
      tierId: existing.tierId,
      firstName: existing.firstName,
      lastName: existing.lastName,
      email: existing.email,
      phone: existing.phone,
      dateOfBirth: existing.dateOfBirth,
      handicapIndex: existing.currentHandicap,
      memberNumber,
      joinDate: new Date(),
      subscriptionStatus: "pending",
    }).returning();
    createdMemberId = newMember.id;
  }

  const [updated] = await db.update(membershipApplicationsTable).set({
    stage: stage as any,
    stageUpdatedAt: new Date(),
    updatedAt: new Date(),
    ...(stage === "rejected" ? { rejectionReason: rejectionReason ?? null } : {}),
    ...(createdMemberId ? { createdMemberId } : {}),
  }).where(eq(membershipApplicationsTable.id, appId)).returning();

  // Send stage-change notification email
  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const branding = { orgName: org?.name, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined };

  if (existing.email) {
    const fullName = `${existing.firstName} ${existing.lastName}`;
    if (stage === "approved") {
      sendApplicationApprovedEmail(existing.email, fullName, org?.name ?? "KHARAGOLF", existing.referenceCode, branding).catch(() => {});
    } else if (stage === "rejected") {
      sendApplicationRejectedEmail(existing.email, fullName, org?.name ?? "KHARAGOLF", rejectionReason ?? null, branding).catch(() => {});
    } else {
      sendApplicationStageChangeEmail(existing.email, fullName, org?.name ?? "KHARAGOLF", stage, existing.referenceCode, branding).catch(() => {});
    }
  }

  res.json(updated);
});

// PATCH /organizations/:orgId/waitlist/:id — update admin notes
router.patch("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const appId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { adminNotes, tierId } = req.body;
  const [existing] = await db.select({ id: membershipApplicationsTable.id }).from(membershipApplicationsTable)
    .where(and(eq(membershipApplicationsTable.id, appId), eq(membershipApplicationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Application not found" }); return; } }

  const [updated] = await db.update(membershipApplicationsTable).set({
    ...(adminNotes !== undefined ? { adminNotes } : {}),
    ...(tierId !== undefined ? { tierId: tierId ? Number(tierId) : null } : {}),
    updatedAt: new Date(),
  }).where(eq(membershipApplicationsTable.id, appId)).returning();

  res.json(updated);
});

// POST /organizations/:orgId/waitlist/:id/notes — add a note
router.post("/:id/notes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const appId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { body, isInternal } = req.body;
  if (!body?.trim()) { { res.status(400).json({ error: "body is required" }); return; } }

  const [existing] = await db.select({ id: membershipApplicationsTable.id }).from(membershipApplicationsTable)
    .where(and(eq(membershipApplicationsTable.id, appId), eq(membershipApplicationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Application not found" }); return; } }

  const user = req.user as { id: number };
  const [note] = await db.insert(applicationNotesTable).values({
    applicationId: appId,
    authorId: user.id,
    body: body.trim(),
    isInternal: isInternal !== false,
  }).returning();

  const [withAuthor] = await db.select({
    id: applicationNotesTable.id,
    body: applicationNotesTable.body,
    isInternal: applicationNotesTable.isInternal,
    createdAt: applicationNotesTable.createdAt,
    authorUsername: appUsersTable.username,
    authorDisplayName: appUsersTable.displayName,
  }).from(applicationNotesTable)
    .leftJoin(appUsersTable, eq(applicationNotesTable.authorId, appUsersTable.id))
    .where(eq(applicationNotesTable.id, note.id));

  res.status(201).json(withAuthor);
});

// DELETE /organizations/:orgId/waitlist/:id — delete application
router.delete("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const appId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select({ id: membershipApplicationsTable.id }).from(membershipApplicationsTable)
    .where(and(eq(membershipApplicationsTable.id, appId), eq(membershipApplicationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Application not found" }); return; } }

  await db.delete(membershipApplicationsTable).where(eq(membershipApplicationsTable.id, appId));
  res.json({ success: true });
});

export default router;
