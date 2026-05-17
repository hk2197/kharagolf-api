/**
 * Swing Video Library API
 * Scoped to: /swing-videos (per-user)
 *
 * POST   /upload-url                Get pre-signed object-storage upload URL
 * POST   /                          Register a new swing video (after client uploads)
 * GET    /                          List my swing videos (paginated)
 * GET    /:id                       Get a single swing video with annotations
 * PATCH  /:id                       Update title/club/view/notes
 * DELETE /:id                       Delete a swing video
 * POST   /:id/annotations           Add a self-annotation (drawings + text + voice-over)
 * POST   /comparisons               Create a side-by-side comparison
 * GET    /comparisons               List my comparisons
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  swingVideosTable,
  swingAnnotationsTable,
  swingComparisonsTable,
} from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { signSwingUpload, verifySwingUpload } from "../lib/swingUploadToken";
import { requireConsent } from "../lib/consent";
import { enqueueFpsProbe } from "../lib/swingFpsProbeQueue";

const router: IRouter = Router({ mergeParams: true });
const storage = new ObjectStorageService();

interface SessionUser { id: number; role?: string; organizationId?: number | null }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

router.post("/upload-url", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  // Task #469 — block swing-video uploads when the member has withdrawn video consent.
  if (!await requireConsent(req, res, "video")) return;
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    const exp = Date.now() + 60 * 60 * 1000; // 1h
    const uploadToken = signSwingUpload(objectPath, user.id, exp);
    res.json({ uploadUrl, objectPath, uploadToken, uploadTokenExp: exp });
  } catch (e) {
    logger.error({ e }, "[swing-videos] upload-url failed");
    res.status(500).json({ error: "Failed to create upload URL" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  // Task #469 — block swing-video registration when the member has withdrawn video consent.
  if (!await requireConsent(req, res, "video")) return;
  const {
    videoUrl, videoUploadToken, videoUploadTokenExp,
    thumbnailUrl, thumbnailUploadToken, thumbnailUploadTokenExp,
    title, club, view, notes, durationSeconds, capturedAt, fps,
  } = req.body as Record<string, unknown>;
  if (typeof videoUrl !== "string" || !videoUrl) {
    res.status(400).json({ error: "videoUrl is required" }); return;
  }
  const normalizedVideoUrl = storage.normalizeObjectEntityPath(videoUrl);
  if (!verifySwingUpload(normalizedVideoUrl, user.id, String(videoUploadToken ?? ""), Number(videoUploadTokenExp ?? 0))) {
    res.status(403).json({ error: "Invalid or expired upload token for video" }); return;
  }
  let normalizedThumb: string | null = null;
  if (thumbnailUrl) {
    normalizedThumb = storage.normalizeObjectEntityPath(thumbnailUrl as string);
    if (!verifySwingUpload(normalizedThumb, user.id, String(thumbnailUploadToken ?? ""), Number(thumbnailUploadTokenExp ?? 0))) {
      res.status(403).json({ error: "Invalid or expired upload token for thumbnail" }); return;
    }
  }
  const validViews = ["dtl", "fo", "side", "behind", "other"] as const;
  const safeView = (typeof view === "string" && (validViews as readonly string[]).includes(view))
    ? view as typeof validViews[number] : "dtl";

  // Task #910 — capture the source video's true frame rate so mobile-only
  // viewers and the very first coach to open the review get accurate
  // per-frame stepping. Task #1057 — keep the upload-completion request
  // snappy by honouring an explicit client-supplied fps inline (e.g. mobile
  // capture metadata) and otherwise scheduling the ffprobe-based probe to
  // run out-of-band after we respond. The existing client-side fallback
  // covers the brief window before the background probe finishes.
  let initialFps: number | null = null;
  if (typeof fps === "number" && Number.isFinite(fps) && fps > 0 && fps <= 1000) {
    initialFps = fps;
  }

  // Task #1217 — Insert the swing_videos row and the pending fps probe in
  // ONE transaction so a crash (or DB connection drop) between the two
  // writes can't strand a video with fps=NULL and no queue row. The
  // probe insert is a single row with an on-conflict no-op, so the
  // additional transactional cost is negligible. The standalone swing
  // -fps probe worker (`swingFpsProbeWorker.ts`) drains the queue
  // out-of-band, so the upload-completion response is not blocked on
  // ffprobe.
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.insert(swingVideosTable).values({
      userId: user.id,
      organizationId: user.organizationId ?? null,
      title: typeof title === "string" ? title : null,
      videoUrl: normalizedVideoUrl,
      thumbnailUrl: normalizedThumb,
      durationSeconds: typeof durationSeconds === "number" ? String(durationSeconds) : null,
      fps: initialFps != null ? String(initialFps) : null,
      club: typeof club === "string" ? club : null,
      view: safeView,
      notes: typeof notes === "string" ? notes : null,
      capturedAt: capturedAt ? new Date(capturedAt as string) : new Date(),
    }).returning();
    if (initialFps == null) {
      await enqueueFpsProbe(r.id, normalizedVideoUrl, tx);
    }
    return r;
  });

  res.json({ swingVideo: row });
});

router.get("/", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50") || 50, 200);
  const rows = await db.select().from(swingVideosTable)
    .where(eq(swingVideosTable.userId, user.id))
    .orderBy(desc(swingVideosTable.capturedAt))
    .limit(limit);
  res.json({ swingVideos: rows });
});

router.get("/comparisons", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const rows = await db.select().from(swingComparisonsTable)
    .where(eq(swingComparisonsTable.userId, user.id))
    .orderBy(desc(swingComparisonsTable.createdAt))
    .limit(100);
  res.json({ comparisons: rows });
});

router.post("/comparisons", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const { leftVideoId, rightVideoId, label } = req.body as Record<string, unknown>;
  const leftId = parseInt(String(leftVideoId));
  const rightId = parseInt(String(rightVideoId));
  if (!leftId || !rightId) { { res.status(400).json({ error: "leftVideoId and rightVideoId required" }); return; } }
  // Authorize: ownership of both videos
  const owned = await db.select({ id: swingVideosTable.id, userId: swingVideosTable.userId })
    .from(swingVideosTable)
    .where(inArray(swingVideosTable.id, [leftId, rightId]));
  if (owned.length !== 2 || owned.some(v => v.userId !== user.id)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const [row] = await db.insert(swingComparisonsTable).values({
    userId: user.id, leftVideoId: leftId, rightVideoId: rightId,
    label: typeof label === "string" ? label : null,
  }).returning();
  res.json({ comparison: row });
});

router.get("/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [row] = await db.select().from(swingVideosTable)
    .where(and(eq(swingVideosTable.id, id), eq(swingVideosTable.userId, user.id)));
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  const annotations = await db.select().from(swingAnnotationsTable)
    .where(eq(swingAnnotationsTable.swingVideoId, id))
    .orderBy(desc(swingAnnotationsTable.createdAt));
  res.json({ swingVideo: row, annotations });
});

router.patch("/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const { title, club, view, notes, fps } = req.body as Record<string, unknown>;
  const validViews = ["dtl", "fo", "side", "behind", "other"] as const;
  const update: Record<string, unknown> = {};
  if (typeof title === "string") update.title = title;
  if (typeof club === "string") update.club = club;
  if (typeof view === "string" && (validViews as readonly string[]).includes(view)) update.view = view;
  if (typeof notes === "string") update.notes = notes;
  // Task #761 — owners may persist a detected frame rate from their own viewer.
  if (typeof fps === "number" && Number.isFinite(fps) && fps > 0 && fps <= 1000) {
    update.fps = String(fps);
  }
  const [row] = await db.update(swingVideosTable).set(update)
    .where(and(eq(swingVideosTable.id, id), eq(swingVideosTable.userId, user.id)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  res.json({ swingVideo: row });
});

router.delete("/:id", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { { res.status(400).json({ error: "Invalid id" }); return; } }
  await db.delete(swingVideosTable)
    .where(and(eq(swingVideosTable.id, id), eq(swingVideosTable.userId, user.id)));
  res.json({ success: true });
});

router.post("/:id/annotations", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!id) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [video] = await db.select().from(swingVideosTable)
    .where(and(eq(swingVideosTable.id, id), eq(swingVideosTable.userId, user.id)));
  if (!video) { { res.status(404).json({ error: "Not found" }); return; } }
  const { drawings, voiceOverUrl, voiceOverUploadToken, voiceOverUploadTokenExp, voiceOverDurationSeconds, textNotes } = req.body as Record<string, unknown>;
  let normalizedVoice: string | null = null;
  if (voiceOverUrl) {
    normalizedVoice = storage.normalizeObjectEntityPath(voiceOverUrl as string);
    if (!verifySwingUpload(normalizedVoice, user.id, voiceOverUploadToken, voiceOverUploadTokenExp)) {
      res.status(403).json({ error: "Invalid or expired upload token for voice-over" }); return;
    }
  }
  const [row] = await db.insert(swingAnnotationsTable).values({
    swingVideoId: id,
    authorUserId: user.id,
    drawings: Array.isArray(drawings) ? drawings as Array<Record<string, unknown>> : [],
    voiceOverUrl: normalizedVoice,
    voiceOverDurationSeconds: typeof voiceOverDurationSeconds === "number" ? String(voiceOverDurationSeconds) : null,
    textNotes: typeof textNotes === "string" ? textNotes : null,
  }).returning();
  res.json({ annotation: row });
});

export default router;
