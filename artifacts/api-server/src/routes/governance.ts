/**
 * Club Administration & Governance Hub API
 *
 * Documents:
 * GET    /organizations/:orgId/governance/documents              List documents
 * POST   /organizations/:orgId/governance/documents              Create document + upload first version
 * GET    /organizations/:orgId/governance/documents/:id          Get document with versions
 * PATCH  /organizations/:orgId/governance/documents/:id          Update metadata
 * DELETE /organizations/:orgId/governance/documents/:id          Soft-delete
 * GET    /organizations/:orgId/governance/documents/:id/versions Version history
 * POST   /organizations/:orgId/governance/documents/:id/versions Upload new version
 *
 * Governance Notices:
 * GET    /organizations/:orgId/governance/notices                List notices (member)
 * POST   /organizations/:orgId/governance/notices                Create notice (admin)
 * PATCH  /organizations/:orgId/governance/notices/:id            Update (admin)
 * DELETE /organizations/:orgId/governance/notices/:id            Delete (admin)
 * POST   /organizations/:orgId/governance/notices/:id/publish    Publish (admin)
 *
 * Committee Meetings:
 * GET    /organizations/:orgId/governance/meetings               List meetings
 * POST   /organizations/:orgId/governance/meetings               Create meeting (admin)
 * GET    /organizations/:orgId/governance/meetings/:id           Get meeting detail
 * PATCH  /organizations/:orgId/governance/meetings/:id           Update meeting (admin)
 * DELETE /organizations/:orgId/governance/meetings/:id           Delete meeting (admin)
 * POST   /organizations/:orgId/governance/meetings/:id/agenda    Add agenda item
 * PATCH  /organizations/:orgId/governance/meetings/:id/agenda/:itemId Update agenda item
 * DELETE /organizations/:orgId/governance/meetings/:id/agenda/:itemId Remove agenda item
 * POST   /organizations/:orgId/governance/meetings/:id/minutes   Save/update minutes
 * POST   /organizations/:orgId/governance/meetings/:id/publish-minutes Publish minutes
 *
 * Votes:
 * GET    /organizations/:orgId/governance/votes                  List votes
 * POST   /organizations/:orgId/governance/votes                  Create vote (admin)
 * GET    /organizations/:orgId/governance/votes/:id              Get vote + results
 * PATCH  /organizations/:orgId/governance/votes/:id              Update vote (admin)
 * POST   /organizations/:orgId/governance/votes/:id/open         Open voting
 * POST   /organizations/:orgId/governance/votes/:id/close        Close voting
 * POST   /organizations/:orgId/governance/votes/:id/ballot       Cast ballot (member)
 */

import { Router, type Request, type Response } from "express";
import {
  db,
  clubDocumentsTable,
  documentVersionsTable,
  governanceNoticesTable,
  committeeMeetingsTable,
  meetingAgendaItemsTable,
  meetingMinutesTable,
  committeeVotesTable,
  voteBallotsTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, asc, sql, lte, isNull, or, ne, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router = Router();

// ── Auth helpers ──────────────────────────────────────────────────────────────

type PortalReq = { portalUser?: { userId?: number } };

function getUserId(req: Request): number | null {
  if (req.isAuthenticated()) {
    const user = req.user as unknown as { id?: number };
    return user?.id ?? null;
  }
  return (req as unknown as PortalReq).portalUser?.userId ?? null;
}

async function getOrgMembership(userId: number, orgId: number) {
  const [row] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
  return row ?? null;
}

async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<{ userId: number; role: string } | null> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return null; }
  const m = await getOrgMembership(userId, orgId);
  if (!m) { res.status(403).json({ error: "Not a member of this organisation" }); return null; }
  return { userId, role: m.role };
}

function isCommitteeRole(role: string): boolean {
  return ["org_admin", "super_admin", "tournament_director", "committee_member", "competition_secretary"].includes(role);
}

function isAdminRole(role: string): boolean {
  return ["org_admin", "super_admin", "tournament_director"].includes(role);
}

function canAccessLevel(role: string, access: string): boolean {
  if (access === "public") return true;
  if (access === "all_members") return true;
  if (access === "committee_only") return isCommitteeRole(role);
  return false;
}

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/governance/documents", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  const { category, access, search } = req.query;
  try {
    let docs = await db.select({
      id: clubDocumentsTable.id,
      title: clubDocumentsTable.title,
      description: clubDocumentsTable.description,
      category: clubDocumentsTable.category,
      access: clubDocumentsTable.access,
      tags: clubDocumentsTable.tags,
      currentVersionId: clubDocumentsTable.currentVersionId,
      uploadedBy: clubDocumentsTable.uploadedBy,
      createdAt: clubDocumentsTable.createdAt,
      updatedAt: clubDocumentsTable.updatedAt,
    })
      .from(clubDocumentsTable)
      .where(and(
        eq(clubDocumentsTable.organizationId, orgId),
        eq(clubDocumentsTable.isActive, true),
      ))
      .orderBy(desc(clubDocumentsTable.updatedAt));

    // Filter by access level
    docs = docs.filter(d => canAccessLevel(member.role, d.access));
    if (category) docs = docs.filter(d => d.category === category);
    if (search) {
      const q = (search as string).toLowerCase();
      docs = docs.filter(d => d.title.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q));
    }

    // Attach current version info
    const docIds = docs.map(d => d.id);
    let versions: { id: number; documentId: number; versionNumber: number; fileName: string; fileUrl: string; fileSizeBytes: number | null; mimeType: string | null; createdAt: Date }[] = [];
    if (docIds.length > 0) {
      versions = await db.select({
        id: documentVersionsTable.id,
        documentId: documentVersionsTable.documentId,
        versionNumber: documentVersionsTable.versionNumber,
        fileName: documentVersionsTable.fileName,
        fileUrl: documentVersionsTable.fileUrl,
        fileSizeBytes: documentVersionsTable.fileSizeBytes,
        mimeType: documentVersionsTable.mimeType,
        createdAt: documentVersionsTable.createdAt,
      }).from(documentVersionsTable)
        .where(inArray(documentVersionsTable.documentId, docIds));
    }

    const versionsById = new Map<number, typeof versions[0]>();
    for (const v of versions) {
      const existing = versionsById.get(v.documentId);
      if (!existing || v.versionNumber > existing.versionNumber) versionsById.set(v.documentId, v);
    }

    const result = docs.map(d => ({ ...d, latestVersion: versionsById.get(d.id) ?? null }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch documents" }); }
});

router.post("/organizations/:orgId/governance/documents", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req);
  const { title, description, category = "other", access = "all_members", tags = [], fileUrl, fileName, fileSizeBytes, mimeType, changeNotes } = req.body;
  if (!title) { { res.status(400).json({ error: "title is required" }); return; } }
  if (!fileUrl || !fileName) { { res.status(400).json({ error: "fileUrl and fileName are required for the first version" }); return; } }
  try {
    const [doc] = await db.insert(clubDocumentsTable).values({
      organizationId: orgId,
      title,
      description: description ?? null,
      category,
      access,
      tags: Array.isArray(tags) ? tags : [],
      uploadedBy: userId,
    }).returning();

    const [version] = await db.insert(documentVersionsTable).values({
      documentId: doc.id,
      organizationId: orgId,
      versionNumber: 1,
      fileUrl,
      fileName,
      fileSizeBytes: fileSizeBytes ?? null,
      mimeType: mimeType ?? null,
      changeNotes: changeNotes ?? null,
      uploadedBy: userId,
    }).returning();

    await db.update(clubDocumentsTable)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(clubDocumentsTable.id, doc.id));

    res.json({ ...doc, currentVersionId: version.id, latestVersion: version });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create document" }); }
});

router.get("/organizations/:orgId/governance/documents/:docId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const [doc] = await db.select().from(clubDocumentsTable)
      .where(and(eq(clubDocumentsTable.id, docId), eq(clubDocumentsTable.organizationId, orgId), eq(clubDocumentsTable.isActive, true)));
    if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
    if (!canAccessLevel(member.role, doc.access)) { { res.status(403).json({ error: "Access denied" }); return; } }

    const allVersions = await db.select().from(documentVersionsTable)
      .where(eq(documentVersionsTable.documentId, docId))
      .orderBy(desc(documentVersionsTable.versionNumber));

    res.json({ ...doc, versions: allVersions, latestVersion: allVersions[0] ?? null });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch document" }); }
});

router.patch("/organizations/:orgId/governance/documents/:docId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const { title, description, category, access, tags } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (category !== undefined) updates.category = category;
  if (access !== undefined) updates.access = access;
  if (tags !== undefined) updates.tags = tags;
  try {
    const [doc] = await db.update(clubDocumentsTable).set(updates)
      .where(and(eq(clubDocumentsTable.id, docId), eq(clubDocumentsTable.organizationId, orgId)))
      .returning();
    if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
    res.json(doc);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to update document" }); }
});

router.delete("/organizations/:orgId/governance/documents/:docId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  try {
    await db.update(clubDocumentsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(clubDocumentsTable.id, docId), eq(clubDocumentsTable.organizationId, orgId)));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to delete document" }); }
});

router.get("/organizations/:orgId/governance/documents/:docId/versions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const [doc] = await db.select({ access: clubDocumentsTable.access }).from(clubDocumentsTable)
      .where(and(eq(clubDocumentsTable.id, docId), eq(clubDocumentsTable.organizationId, orgId)));
    if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
    if (!canAccessLevel(member.role, doc.access)) { { res.status(403).json({ error: "Access denied" }); return; } }

    const versions = await db.select().from(documentVersionsTable)
      .where(eq(documentVersionsTable.documentId, docId))
      .orderBy(desc(documentVersionsTable.versionNumber));
    res.json(versions);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch versions" }); }
});

router.post("/organizations/:orgId/governance/documents/:docId/versions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const userId = getUserId(req);
  const { fileUrl, fileName, fileSizeBytes, mimeType, changeNotes } = req.body;
  if (!fileUrl || !fileName) { { res.status(400).json({ error: "fileUrl and fileName are required" }); return; } }
  try {
    const [doc] = await db.select().from(clubDocumentsTable)
      .where(and(eq(clubDocumentsTable.id, docId), eq(clubDocumentsTable.organizationId, orgId)));
    if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }

    const [lastVersion] = await db.select({ versionNumber: documentVersionsTable.versionNumber })
      .from(documentVersionsTable).where(eq(documentVersionsTable.documentId, docId))
      .orderBy(desc(documentVersionsTable.versionNumber)).limit(1);
    const nextVersion = (lastVersion?.versionNumber ?? 0) + 1;

    const [version] = await db.insert(documentVersionsTable).values({
      documentId: docId,
      organizationId: orgId,
      versionNumber: nextVersion,
      fileUrl,
      fileName,
      fileSizeBytes: fileSizeBytes ?? null,
      mimeType: mimeType ?? null,
      changeNotes: changeNotes ?? null,
      uploadedBy: userId,
    }).returning();

    await db.update(clubDocumentsTable)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(clubDocumentsTable.id, docId));

    res.json(version);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to add version" }); }
});

// ── GOVERNANCE NOTICES ────────────────────────────────────────────────────────

router.get("/organizations/:orgId/governance/notices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  const now = new Date();
  try {
    const all = await db.select().from(governanceNoticesTable)
      .where(eq(governanceNoticesTable.organizationId, orgId))
      .orderBy(desc(governanceNoticesTable.isPinned), desc(governanceNoticesTable.createdAt));

    // Filter by access and expiry
    const visible = all.filter(n => {
      if (!canAccessLevel(member.role, n.access)) return false;
      if (!isAdminRole(member.role)) {
        if (!n.isPublished) return false;
        if (n.expiresAt && new Date(n.expiresAt) < now) return false;
      }
      return true;
    });
    res.json(visible);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch notices" }); }
});

router.post("/organizations/:orgId/governance/notices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req);
  const { title, body, isPinned = false, access = "all_members", expiresAt, attachmentUrl, attachmentName } = req.body;
  if (!title || !body) { { res.status(400).json({ error: "title and body are required" }); return; } }
  try {
    const [notice] = await db.insert(governanceNoticesTable).values({
      organizationId: orgId,
      title,
      body,
      isPinned,
      access,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      attachmentUrl: attachmentUrl ?? null,
      attachmentName: attachmentName ?? null,
      postedBy: userId,
    }).returning();
    res.json(notice);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create notice" }); }
});

router.patch("/organizations/:orgId/governance/notices/:noticeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const noticeId = parseInt(String((req.params as Record<string, string>).noticeId));
  const { title, body, isPinned, access, expiresAt, attachmentUrl, attachmentName } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (body !== undefined) updates.body = body;
  if (isPinned !== undefined) updates.isPinned = isPinned;
  if (access !== undefined) updates.access = access;
  if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (attachmentUrl !== undefined) updates.attachmentUrl = attachmentUrl;
  if (attachmentName !== undefined) updates.attachmentName = attachmentName;
  try {
    const [notice] = await db.update(governanceNoticesTable).set(updates)
      .where(and(eq(governanceNoticesTable.id, noticeId), eq(governanceNoticesTable.organizationId, orgId)))
      .returning();
    if (!notice) { { res.status(404).json({ error: "Notice not found" }); return; } }
    res.json(notice);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to update notice" }); }
});

router.delete("/organizations/:orgId/governance/notices/:noticeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const noticeId = parseInt(String((req.params as Record<string, string>).noticeId));
  try {
    await db.delete(governanceNoticesTable)
      .where(and(eq(governanceNoticesTable.id, noticeId), eq(governanceNoticesTable.organizationId, orgId)));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to delete notice" }); }
});

router.post("/organizations/:orgId/governance/notices/:noticeId/publish", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const noticeId = parseInt(String((req.params as Record<string, string>).noticeId));
  try {
    const [notice] = await db.update(governanceNoticesTable)
      .set({ isPublished: true, publishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(governanceNoticesTable.id, noticeId), eq(governanceNoticesTable.organizationId, orgId)))
      .returning();
    if (!notice) { { res.status(404).json({ error: "Notice not found" }); return; } }
    res.json(notice);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to publish notice" }); }
});

// ── COMMITTEE MEETINGS ────────────────────────────────────────────────────────

router.get("/organizations/:orgId/governance/meetings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const meetings = await db.select().from(committeeMeetingsTable)
      .where(eq(committeeMeetingsTable.organizationId, orgId))
      .orderBy(desc(committeeMeetingsTable.scheduledAt));

    const filtered = meetings.filter(m => canAccessLevel(member.role, m.access));
    res.json(filtered);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch meetings" }); }
});

router.post("/organizations/:orgId/governance/meetings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req);
  const { title, description, scheduledAt, location, chairpersonId, access = "committee_only" } = req.body;
  if (!title || !scheduledAt) { { res.status(400).json({ error: "title and scheduledAt are required" }); return; } }
  try {
    const [meeting] = await db.insert(committeeMeetingsTable).values({
      organizationId: orgId,
      title,
      description: description ?? null,
      scheduledAt: new Date(scheduledAt),
      location: location ?? null,
      chairpersonId: chairpersonId ?? null,
      access,
      createdBy: userId,
    }).returning();
    res.json(meeting);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create meeting" }); }
});

router.get("/organizations/:orgId/governance/meetings/:meetingId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const [meeting] = await db.select().from(committeeMeetingsTable)
      .where(and(eq(committeeMeetingsTable.id, meetingId), eq(committeeMeetingsTable.organizationId, orgId)));
    if (!meeting) { { res.status(404).json({ error: "Meeting not found" }); return; } }
    if (!canAccessLevel(member.role, meeting.access)) { { res.status(403).json({ error: "Access denied" }); return; } }

    const agendaItems = await db.select().from(meetingAgendaItemsTable)
      .where(eq(meetingAgendaItemsTable.meetingId, meetingId))
      .orderBy(asc(meetingAgendaItemsTable.sortOrder));

    const [minutes] = await db.select().from(meetingMinutesTable)
      .where(eq(meetingMinutesTable.meetingId, meetingId)).limit(1);

    res.json({ ...meeting, agendaItems, minutes: minutes ?? null });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch meeting" }); }
});

router.patch("/organizations/:orgId/governance/meetings/:meetingId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const { title, description, scheduledAt, location, chairpersonId, status, access } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (scheduledAt !== undefined) updates.scheduledAt = new Date(scheduledAt);
  if (location !== undefined) updates.location = location;
  if (chairpersonId !== undefined) updates.chairpersonId = chairpersonId;
  if (status !== undefined) updates.status = status;
  if (access !== undefined) updates.access = access;
  try {
    const [meeting] = await db.update(committeeMeetingsTable).set(updates)
      .where(and(eq(committeeMeetingsTable.id, meetingId), eq(committeeMeetingsTable.organizationId, orgId)))
      .returning();
    if (!meeting) { { res.status(404).json({ error: "Meeting not found" }); return; } }
    res.json(meeting);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to update meeting" }); }
});

router.delete("/organizations/:orgId/governance/meetings/:meetingId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  try {
    await db.delete(committeeMeetingsTable)
      .where(and(eq(committeeMeetingsTable.id, meetingId), eq(committeeMeetingsTable.organizationId, orgId)));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to delete meeting" }); }
});

// ── AGENDA ITEMS ──────────────────────────────────────────────────────────────

router.post("/organizations/:orgId/governance/meetings/:meetingId/agenda", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const { title, description, sortOrder = 0, duration, documentId } = req.body;
  if (!title) { { res.status(400).json({ error: "title is required" }); return; } }
  try {
    const [item] = await db.insert(meetingAgendaItemsTable).values({
      meetingId,
      organizationId: orgId,
      title,
      description: description ?? null,
      sortOrder,
      duration: duration ?? null,
      documentId: documentId ?? null,
    }).returning();
    res.json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to add agenda item" }); }
});

router.patch("/organizations/:orgId/governance/meetings/:meetingId/agenda/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  const { title, description, sortOrder, duration, documentId } = req.body;
  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (duration !== undefined) updates.duration = duration;
  if (documentId !== undefined) updates.documentId = documentId;
  try {
    const [item] = await db.update(meetingAgendaItemsTable).set(updates)
      .where(and(eq(meetingAgendaItemsTable.id, itemId), eq(meetingAgendaItemsTable.meetingId, meetingId)))
      .returning();
    if (!item) { { res.status(404).json({ error: "Agenda item not found" }); return; } }
    res.json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to update agenda item" }); }
});

router.delete("/organizations/:orgId/governance/meetings/:meetingId/agenda/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  try {
    await db.delete(meetingAgendaItemsTable)
      .where(and(eq(meetingAgendaItemsTable.id, itemId), eq(meetingAgendaItemsTable.meetingId, meetingId)));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to delete agenda item" }); }
});

// ── MEETING MINUTES ───────────────────────────────────────────────────────────

router.post("/organizations/:orgId/governance/meetings/:meetingId/minutes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  const userId = getUserId(req);
  const { content, attendees = [], attachmentUrl, attachmentName } = req.body;
  if (!content) { { res.status(400).json({ error: "content is required" }); return; } }
  try {
    const existing = await db.select({ id: meetingMinutesTable.id }).from(meetingMinutesTable)
      .where(eq(meetingMinutesTable.meetingId, meetingId)).limit(1);

    if (existing.length > 0) {
      const [minutes] = await db.update(meetingMinutesTable)
        .set({ content, attendees, attachmentUrl: attachmentUrl ?? null, attachmentName: attachmentName ?? null, updatedAt: new Date() })
        .where(eq(meetingMinutesTable.id, existing[0].id))
        .returning();
      res.json(minutes);
    } else {
      const [minutes] = await db.insert(meetingMinutesTable).values({
        meetingId,
        organizationId: orgId,
        content,
        attendees: Array.isArray(attendees) ? attendees : [],
        attachmentUrl: attachmentUrl ?? null,
        attachmentName: attachmentName ?? null,
        recordedBy: userId,
      }).returning();
      res.json(minutes);
    }
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to save minutes" }); }
});

router.post("/organizations/:orgId/governance/meetings/:meetingId/publish-minutes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const meetingId = parseInt(String((req.params as Record<string, string>).meetingId));
  try {
    const [meeting] = await db.update(committeeMeetingsTable)
      .set({ minutesPublished: true, minutesPublishedAt: new Date(), status: "completed", updatedAt: new Date() })
      .where(and(eq(committeeMeetingsTable.id, meetingId), eq(committeeMeetingsTable.organizationId, orgId)))
      .returning();
    if (!meeting) { { res.status(404).json({ error: "Meeting not found" }); return; } }
    res.json(meeting);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to publish minutes" }); }
});

// ── COMMITTEE VOTES ───────────────────────────────────────────────────────────

router.get("/organizations/:orgId/governance/votes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const votes = await db.select().from(committeeVotesTable)
      .where(eq(committeeVotesTable.organizationId, orgId))
      .orderBy(desc(committeeVotesTable.createdAt));

    const filtered = votes.filter(v => canAccessLevel(member.role, v.access));
    res.json(filtered);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch votes" }); }
});

router.post("/organizations/:orgId/governance/votes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req);
  const { title, description, options = [], access = "committee_only", deadline, meetingId, allowAbstain = true, resultsVisible = false } = req.body;
  if (!title) { { res.status(400).json({ error: "title is required" }); return; } }
  if (!Array.isArray(options) || options.length < 2) { { res.status(400).json({ error: "At least 2 options are required" }); return; } }
  try {
    const [vote] = await db.insert(committeeVotesTable).values({
      organizationId: orgId,
      title,
      description: description ?? null,
      options,
      access,
      deadline: deadline ? new Date(deadline) : null,
      meetingId: meetingId ?? null,
      allowAbstain,
      resultsVisible,
      createdBy: userId,
    }).returning();
    res.json(vote);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create vote" }); }
});

router.get("/organizations/:orgId/governance/votes/:voteId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const voteId = parseInt(String((req.params as Record<string, string>).voteId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  try {
    const [vote] = await db.select().from(committeeVotesTable)
      .where(and(eq(committeeVotesTable.id, voteId), eq(committeeVotesTable.organizationId, orgId)));
    if (!vote) { { res.status(404).json({ error: "Vote not found" }); return; } }
    if (!canAccessLevel(member.role, vote.access)) { { res.status(403).json({ error: "Access denied" }); return; } }

    const ballots = await db.select().from(voteBallotsTable)
      .where(eq(voteBallotsTable.voteId, voteId));

    // Tally results
    const tally: Record<string, number> = {};
    let abstainCount = 0;
    for (const b of ballots) {
      if (b.abstained) { abstainCount++; continue; }
      if (b.choice) tally[b.choice] = (tally[b.choice] ?? 0) + 1;
    }

    // Check if user has voted
    const userBallot = ballots.find(b => b.userId === member.userId) ?? null;

    const canSeeResults = isAdminRole(member.role) || vote.resultsVisible || vote.status === "closed";

    res.json({
      ...vote,
      totalVotes: ballots.length,
      userHasVoted: !!userBallot,
      userChoice: userBallot?.choice ?? null,
      userAbstained: userBallot?.abstained ?? false,
      results: canSeeResults ? { tally, abstainCount } : null,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch vote" }); }
});

router.patch("/organizations/:orgId/governance/votes/:voteId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const voteId = parseInt(String((req.params as Record<string, string>).voteId));
  const { title, description, options, access, deadline, allowAbstain, resultsVisible } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (options !== undefined) updates.options = options;
  if (access !== undefined) updates.access = access;
  if (deadline !== undefined) updates.deadline = deadline ? new Date(deadline) : null;
  if (allowAbstain !== undefined) updates.allowAbstain = allowAbstain;
  if (resultsVisible !== undefined) updates.resultsVisible = resultsVisible;
  try {
    const [vote] = await db.update(committeeVotesTable).set(updates)
      .where(and(eq(committeeVotesTable.id, voteId), eq(committeeVotesTable.organizationId, orgId)))
      .returning();
    if (!vote) { { res.status(404).json({ error: "Vote not found" }); return; } }
    res.json(vote);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to update vote" }); }
});

router.post("/organizations/:orgId/governance/votes/:voteId/open", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const voteId = parseInt(String((req.params as Record<string, string>).voteId));
  try {
    const [vote] = await db.update(committeeVotesTable)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(eq(committeeVotesTable.id, voteId), eq(committeeVotesTable.organizationId, orgId)))
      .returning();
    if (!vote) { { res.status(404).json({ error: "Vote not found" }); return; } }
    res.json(vote);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to open vote" }); }
});

router.post("/organizations/:orgId/governance/votes/:voteId/close", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const voteId = parseInt(String((req.params as Record<string, string>).voteId));
  try {
    const [vote] = await db.update(committeeVotesTable)
      .set({ status: "closed", closedAt: new Date(), resultsVisible: true, updatedAt: new Date() })
      .where(and(eq(committeeVotesTable.id, voteId), eq(committeeVotesTable.organizationId, orgId)))
      .returning();
    if (!vote) { { res.status(404).json({ error: "Vote not found" }); return; } }
    res.json(vote);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to close vote" }); }
});

router.post("/organizations/:orgId/governance/votes/:voteId/ballot", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const voteId = parseInt(String((req.params as Record<string, string>).voteId));
  const member = await requireOrgMember(req, res, orgId);
  if (!member) return;
  const { choice, abstain = false } = req.body;
  try {
    const [vote] = await db.select().from(committeeVotesTable)
      .where(and(eq(committeeVotesTable.id, voteId), eq(committeeVotesTable.organizationId, orgId)));
    if (!vote) { { res.status(404).json({ error: "Vote not found" }); return; } }
    if (!canAccessLevel(member.role, vote.access)) { { res.status(403).json({ error: "Access denied" }); return; } }
    if (vote.status !== "open") { { res.status(400).json({ error: "Voting is not open" }); return; } }
    if (vote.deadline && new Date(vote.deadline) < new Date()) { { res.status(400).json({ error: "Voting deadline has passed" }); return; } }

    const isAbstaining = abstain && vote.allowAbstain;
    if (!isAbstaining && !choice) { { res.status(400).json({ error: "choice is required unless abstaining" }); return; } }
    if (!isAbstaining && choice && !(vote.options as string[]).includes(choice)) {
      res.status(400).json({ error: "Invalid choice" }); return;
    }

    const existing = await db.select({ id: voteBallotsTable.id }).from(voteBallotsTable)
      .where(and(eq(voteBallotsTable.voteId, voteId), eq(voteBallotsTable.userId, member.userId))).limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "You have already voted" }); return;
    }

    const [ballot] = await db.insert(voteBallotsTable).values({
      voteId,
      organizationId: orgId,
      userId: member.userId,
      choice: isAbstaining ? null : choice,
      abstained: isAbstaining,
    }).returning();

    res.json({ success: true, ballot });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to cast ballot" }); }
});

export default router;
