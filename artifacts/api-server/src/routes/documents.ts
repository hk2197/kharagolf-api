import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "crypto";
import { db } from "@workspace/db";
import {
  operationalDocumentsTable, eventDocumentsTable,
  tournamentsTable, leaguesTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });
const storage = new ObjectStorageService();

function getHmacSecret(): string {
  const secret = process.env["PRIVATE_OBJECT_DIR"];
  if (!secret) throw new Error("PRIVATE_OBJECT_DIR env var is required");
  return secret;
}

function signUploadPath(objectPath: string): string {
  return createHmac("sha256", getHmacSecret()).update(objectPath).digest("hex");
}

function verifyUploadToken(objectPath: string, token: string): boolean {
  try {
    return signUploadPath(objectPath) === token;
  } catch {
    return false;
  }
}

function userFromReq(req: Request) {
  return req.user as { id?: number; role?: string; organizationId?: number } | undefined;
}

function isOrgAdmin(caller: ReturnType<typeof userFromReq>, orgId: number): boolean {
  if (!caller?.id) return false;
  if (caller.role === "super_admin") return true;
  return ["org_admin", "tournament_director"].includes(caller.role ?? "") && caller.organizationId === orgId;
}

const ALLOWED_DOC_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "image/jpeg", "image/png", "image/webp",
];

const DOC_CATEGORIES = ["local_rules", "pace_of_play", "policy", "general", "results", "notice"];

// ─── UPLOAD URL ─────────────────────────────────────────────────────────────

// POST /api/organizations/:orgId/documents/upload-url
router.post("/organizations/:orgId/documents/upload-url", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const { contentType, size } = req.body;

  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  if (size !== undefined && typeof size === "number" && size > MAX_FILE_SIZE) {
    res.status(400).json({ error: "File too large. Maximum size is 50 MB." }); return;
  }

  if (contentType && !ALLOWED_DOC_CONTENT_TYPES.includes(contentType)) {
    res.status(400).json({ error: "Unsupported file type." }); return;
  }

  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    const uploadToken = signUploadPath(objectPath);
    res.json({ uploadURL, objectPath, uploadToken });
  } catch (err) {
    logger.error({ err }, "[documents] Failed to generate upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// ─── CLUB DOCUMENTS CRUD ────────────────────────────────────────────────────

// GET /api/organizations/:orgId/documents
// Admins see all; org members see only public; unauthenticated → 403
router.get("/organizations/:orgId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  const isAdmin = isOrgAdmin(caller, orgId);
  const isMember = caller?.organizationId === orgId;
  if (!isAdmin && !isMember) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const docs = await db
    .select()
    .from(operationalDocumentsTable)
    .where(
      isAdmin
        ? eq(operationalDocumentsTable.organizationId, orgId)
        : and(eq(operationalDocumentsTable.organizationId, orgId), eq(operationalDocumentsTable.visibility, "public"))
    )
    .orderBy(asc(operationalDocumentsTable.createdAt));

  res.json(docs);
});

// POST /api/organizations/:orgId/documents
router.post("/organizations/:orgId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const { title, category, visibility, objectPath, uploadToken, filename, contentType, fileSize } = req.body;

  if (!title?.trim()) { { res.status(400).json({ error: "title is required" }); return; } }
  if (!objectPath) { { res.status(400).json({ error: "objectPath is required" }); return; } }
  if (!uploadToken || !verifyUploadToken(objectPath, uploadToken)) {
    res.status(400).json({ error: "Invalid upload token" }); return;
  }

  const resolvedCategory = DOC_CATEGORIES.includes(category) ? category : "general";
  const resolvedVisibility = ["public", "members_only"].includes(visibility) ? visibility : "public";

  const [doc] = await db
    .insert(operationalDocumentsTable)
    .values({
      organizationId: orgId,
      title: title.trim(),
      category: resolvedCategory,
      visibility: resolvedVisibility,
      objectPath,
      filename: filename ?? null,
      contentType: contentType ?? null,
      fileSize: fileSize ?? null,
      uploadedByUserId: caller?.id ?? null,
    })
    .returning();

  res.status(201).json(doc);
});

// PUT /api/organizations/:orgId/documents/:docId
router.put("/organizations/:orgId/documents/:docId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  if (isNaN(orgId) || isNaN(docId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const { title, category, visibility } = req.body;

  const resolvedCategory = DOC_CATEGORIES.includes(category) ? category : "general";
  const resolvedVisibility = ["public", "members_only"].includes(visibility) ? visibility : "public";

  const [doc] = await db
    .update(operationalDocumentsTable)
    .set({
      ...(title?.trim() ? { title: title.trim() } : {}),
      category: resolvedCategory,
      visibility: resolvedVisibility,
      updatedAt: new Date(),
    })
    .where(and(eq(operationalDocumentsTable.id, docId), eq(operationalDocumentsTable.organizationId, orgId)))
    .returning();

  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
  res.json(doc);
});

// DELETE /api/organizations/:orgId/documents/:docId
router.delete("/organizations/:orgId/documents/:docId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  if (isNaN(orgId) || isNaN(docId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [doc] = await db
    .select()
    .from(operationalDocumentsTable)
    .where(and(eq(operationalDocumentsTable.id, docId), eq(operationalDocumentsTable.organizationId, orgId)))
    .limit(1);

  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }

  try {
    if (doc.objectPath) {
      const file = await storage.getObjectEntityFile(doc.objectPath);
      await file.delete({ ignoreNotFound: true });
    }
  } catch (err) {
    logger.warn({ err, docId }, "[documents] Could not delete object from storage");
  }

  await db.delete(eventDocumentsTable).where(eq(eventDocumentsTable.documentId, docId));
  await db.delete(operationalDocumentsTable).where(eq(operationalDocumentsTable.id, docId));

  res.status(204).send();
});

// GET /api/organizations/:orgId/documents/:docId/download
router.get("/organizations/:orgId/documents/:docId/download", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  if (isNaN(orgId) || isNaN(docId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const [doc] = await db
    .select()
    .from(operationalDocumentsTable)
    .where(and(eq(operationalDocumentsTable.id, docId), eq(operationalDocumentsTable.organizationId, orgId)))
    .limit(1);

  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }

  if (doc.visibility === "members_only" && !isOrgAdmin(caller, orgId) && caller?.organizationId !== orgId) {
    res.status(403).json({ error: "Members only" }); return;
  }

  try {
    const file = await storage.getObjectEntityFile(doc.objectPath);
    const [metadata] = await file.getMetadata();
    const nodeStream = file.createReadStream();

    res.setHeader("Content-Type", (metadata.contentType as string) || doc.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.filename ?? doc.title)}"`);
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    res.setHeader("Cache-Control", "private, max-age=3600");

    nodeStream.on("error", (err) => {
      logger.error({ err, docId }, "[documents] Stream error");
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" }); return;
    }
    logger.error({ err, docId }, "[documents] Download error");
    res.status(500).json({ error: "Download failed" });
  }
});

// ─── EVENT DOCUMENTS (attach/detach) ────────────────────────────────────────

// GET /api/organizations/:orgId/tournaments/:tournamentId/documents
// Admins see all; org members see only public
router.get("/organizations/:orgId/tournaments/:tournamentId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(orgId) || isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const isAdmin = isOrgAdmin(caller, orgId);
  const isMember = caller?.organizationId === orgId;
  if (!isAdmin && !isMember) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const publicOnly = !isAdmin;
  const docs = await getEventDocs("tournament", tournamentId, publicOnly, orgId);
  res.json(docs);
});

// POST /api/organizations/:orgId/tournaments/:tournamentId/documents
router.post("/organizations/:orgId/tournaments/:tournamentId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(orgId) || isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [t] = await db.select({ id: tournamentsTable.id }).from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId))).limit(1);
  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const { documentId, title, category, visibility, objectPath, uploadToken, filename, contentType, fileSize } = req.body;

  let resolvedDocId: number;

  if (documentId) {
    const docIdInt = parseInt(String(documentId));
    const [doc] = await db.select({ id: operationalDocumentsTable.id })
      .from(operationalDocumentsTable)
      .where(and(eq(operationalDocumentsTable.id, docIdInt), eq(operationalDocumentsTable.organizationId, orgId)))
      .limit(1);
    if (!doc) { { res.status(404).json({ error: "Document not found in library" }); return; } }
    resolvedDocId = doc.id;
  } else {
    if (!title?.trim()) { { res.status(400).json({ error: "title is required for new documents" }); return; } }
    if (!objectPath || !uploadToken || !verifyUploadToken(objectPath, uploadToken)) {
      res.status(400).json({ error: "Valid objectPath and uploadToken are required" }); return;
    }
    const resolvedCategory = DOC_CATEGORIES.includes(category) ? category : "general";
    const resolvedVisibility = ["public", "members_only"].includes(visibility) ? visibility : "public";
    const [doc] = await db.insert(operationalDocumentsTable).values({
      organizationId: orgId,
      title: title.trim(),
      category: resolvedCategory,
      visibility: resolvedVisibility,
      objectPath,
      filename: filename ?? null,
      contentType: contentType ?? null,
      fileSize: fileSize ?? null,
      uploadedByUserId: caller?.id ?? null,
    }).returning();
    resolvedDocId = doc.id;
  }

  const [ev] = await db.insert(eventDocumentsTable).values({
    documentId: resolvedDocId,
    eventType: "tournament",
    eventId: tournamentId,
  }).onConflictDoNothing().returning();

  const [doc] = await db.select().from(operationalDocumentsTable).where(eq(operationalDocumentsTable.id, resolvedDocId));
  res.status(201).json({ ...doc, eventDocumentId: ev?.id ?? null });
});

// DELETE /api/organizations/:orgId/tournaments/:tournamentId/documents/:eventDocId
router.delete("/organizations/:orgId/tournaments/:tournamentId/documents/:eventDocId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const eventDocId = parseInt(String((req.params as Record<string, string>).eventDocId));
  if (isNaN(orgId) || isNaN(tournamentId) || isNaN(eventDocId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  // Verify the event doc belongs to this org (join through operational_documents.organization_id)
  const [evDoc] = await db
    .select({ id: eventDocumentsTable.id })
    .from(eventDocumentsTable)
    .innerJoin(operationalDocumentsTable, eq(operationalDocumentsTable.id, eventDocumentsTable.documentId))
    .where(and(
      eq(eventDocumentsTable.id, eventDocId),
      eq(eventDocumentsTable.eventType, "tournament"),
      eq(eventDocumentsTable.eventId, tournamentId),
      eq(operationalDocumentsTable.organizationId, orgId),
    ));
  if (!evDoc) { { res.status(404).json({ error: "Event document not found" }); return; } }

  await db.delete(eventDocumentsTable).where(eq(eventDocumentsTable.id, eventDocId));
  res.status(204).send();
});

// GET /api/organizations/:orgId/leagues/:leagueId/documents
// Admins see all; org members see only public
router.get("/organizations/:orgId/leagues/:leagueId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (isNaN(orgId) || isNaN(leagueId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const isAdmin = isOrgAdmin(caller, orgId);
  const isMember = caller?.organizationId === orgId;
  if (!isAdmin && !isMember) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const publicOnly = !isAdmin;
  const docs = await getEventDocs("league", leagueId, publicOnly, orgId);
  res.json(docs);
});

// POST /api/organizations/:orgId/leagues/:leagueId/documents
router.post("/organizations/:orgId/leagues/:leagueId/documents", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (isNaN(orgId) || isNaN(leagueId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [l] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId))).limit(1);
  if (!l) { { res.status(404).json({ error: "League not found" }); return; } }

  const { documentId, title, category, visibility, objectPath, uploadToken, filename, contentType, fileSize } = req.body;

  let resolvedDocId: number;

  if (documentId) {
    const docIdInt = parseInt(String(documentId));
    const [doc] = await db.select({ id: operationalDocumentsTable.id })
      .from(operationalDocumentsTable)
      .where(and(eq(operationalDocumentsTable.id, docIdInt), eq(operationalDocumentsTable.organizationId, orgId)))
      .limit(1);
    if (!doc) { { res.status(404).json({ error: "Document not found in library" }); return; } }
    resolvedDocId = doc.id;
  } else {
    if (!title?.trim()) { { res.status(400).json({ error: "title is required for new documents" }); return; } }
    if (!objectPath || !uploadToken || !verifyUploadToken(objectPath, uploadToken)) {
      res.status(400).json({ error: "Valid objectPath and uploadToken are required" }); return;
    }
    const resolvedCategory = DOC_CATEGORIES.includes(category) ? category : "general";
    const resolvedVisibility = ["public", "members_only"].includes(visibility) ? visibility : "public";
    const [doc] = await db.insert(operationalDocumentsTable).values({
      organizationId: orgId,
      title: title.trim(),
      category: resolvedCategory,
      visibility: resolvedVisibility,
      objectPath,
      filename: filename ?? null,
      contentType: contentType ?? null,
      fileSize: fileSize ?? null,
      uploadedByUserId: caller?.id ?? null,
    }).returning();
    resolvedDocId = doc.id;
  }

  const [ev] = await db.insert(eventDocumentsTable).values({
    documentId: resolvedDocId,
    eventType: "league",
    eventId: leagueId,
  }).onConflictDoNothing().returning();

  const [doc] = await db.select().from(operationalDocumentsTable).where(eq(operationalDocumentsTable.id, resolvedDocId));
  res.status(201).json({ ...doc, eventDocumentId: ev?.id ?? null });
});

// DELETE /api/organizations/:orgId/leagues/:leagueId/documents/:eventDocId
router.delete("/organizations/:orgId/leagues/:leagueId/documents/:eventDocId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const eventDocId = parseInt(String((req.params as Record<string, string>).eventDocId));
  if (isNaN(orgId) || isNaN(leagueId) || isNaN(eventDocId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!isOrgAdmin(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  // Verify the event doc belongs to this org (join through operational_documents.organization_id)
  const [evDoc] = await db
    .select({ id: eventDocumentsTable.id })
    .from(eventDocumentsTable)
    .innerJoin(operationalDocumentsTable, eq(operationalDocumentsTable.id, eventDocumentsTable.documentId))
    .where(and(
      eq(eventDocumentsTable.id, eventDocId),
      eq(eventDocumentsTable.eventType, "league"),
      eq(eventDocumentsTable.eventId, leagueId),
      eq(operationalDocumentsTable.organizationId, orgId),
    ));
  if (!evDoc) { { res.status(404).json({ error: "Event document not found" }); return; } }

  await db.delete(eventDocumentsTable).where(eq(eventDocumentsTable.id, eventDocId));
  res.status(204).send();
});

// ─── PUBLIC DOCUMENT LISTING ─────────────────────────────────────────────────

// GET /api/public/tournaments/:tournamentId/documents
router.get("/public/tournaments/:tournamentId/documents", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const docs = await getEventDocs("tournament", tournamentId, true);
  res.json(docs);
});

// GET /api/public/leagues/:leagueId/documents
router.get("/public/leagues/:leagueId/documents", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (isNaN(leagueId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const docs = await getEventDocs("league", leagueId, true);
  res.json(docs);
});

// GET /api/public/tournaments/:tournamentId/documents/:documentId — public download
router.get("/public/tournaments/:tournamentId/documents/:documentId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const documentId = parseInt(String((req.params as Record<string, string>).documentId));
  if (isNaN(tournamentId) || isNaN(documentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  await streamPublicEventDoc("tournament", tournamentId, documentId, res);
});

// GET /api/public/leagues/:leagueId/documents/:documentId — public download
router.get("/public/leagues/:leagueId/documents/:documentId", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const documentId = parseInt(String((req.params as Record<string, string>).documentId));
  if (isNaN(leagueId) || isNaN(documentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  await streamPublicEventDoc("league", leagueId, documentId, res);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function streamPublicEventDoc(eventType: string, eventId: number, documentId: number, res: Response) {
  const [row] = await db
    .select({ doc: operationalDocumentsTable })
    .from(eventDocumentsTable)
    .innerJoin(operationalDocumentsTable, eq(operationalDocumentsTable.id, eventDocumentsTable.documentId))
    .where(and(
      eq(eventDocumentsTable.eventType, eventType),
      eq(eventDocumentsTable.eventId, eventId),
      eq(operationalDocumentsTable.id, documentId),
      eq(operationalDocumentsTable.visibility, "public"),
    ))
    .limit(1);

  if (!row) { { res.status(404).json({ error: "Document not found or not public" }); return; } }
  const doc = row.doc;

  try {
    const file = await storage.getObjectEntityFile(doc.objectPath);
    const [metadata] = await file.getMetadata();
    const nodeStream = file.createReadStream();
    res.setHeader("Content-Type", (metadata.contentType as string) || doc.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.filename ?? doc.title)}"`);
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    res.setHeader("Cache-Control", "public, max-age=3600");
    nodeStream.on("error", (err) => {
      logger.error({ err, documentId }, "[documents] Public stream error");
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" }); return;
    }
    logger.error({ err, documentId }, "[documents] Public download error");
    res.status(500).json({ error: "Download failed" });
  }
}

async function getEventDocs(eventType: string, eventId: number, publicOnly: boolean, orgId?: number) {
  const conditions = [
    eq(eventDocumentsTable.eventType, eventType),
    eq(eventDocumentsTable.eventId, eventId),
    ...(publicOnly ? [eq(operationalDocumentsTable.visibility, "public")] : []),
    ...(orgId !== undefined ? [eq(operationalDocumentsTable.organizationId, orgId)] : []),
  ];

  const eventDocs = await db
    .select({
      eventDocumentId: eventDocumentsTable.id,
      displayOrder: eventDocumentsTable.displayOrder,
      documentId: operationalDocumentsTable.id,
      title: operationalDocumentsTable.title,
      category: operationalDocumentsTable.category,
      visibility: operationalDocumentsTable.visibility,
      filename: operationalDocumentsTable.filename,
      contentType: operationalDocumentsTable.contentType,
      fileSize: operationalDocumentsTable.fileSize,
      objectPath: operationalDocumentsTable.objectPath,
      createdAt: operationalDocumentsTable.createdAt,
    })
    .from(eventDocumentsTable)
    .innerJoin(operationalDocumentsTable, eq(operationalDocumentsTable.id, eventDocumentsTable.documentId))
    .where(and(...conditions))
    .orderBy(asc(eventDocumentsTable.displayOrder), asc(eventDocumentsTable.createdAt));

  return eventDocs;
}

export default router;
