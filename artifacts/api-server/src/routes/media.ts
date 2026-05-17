import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, randomUUID } from "crypto";
import { spawn } from "child_process";
import { createWriteStream, unlinkSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { db } from "@workspace/db";
import {
  mediaTable, tournamentsTable, leaguesTable, playersTable, leagueMembersTable,
  swingVideosTable, swingReviewRequestsTable, swingAnnotationsTable, teachingProsTable,
  appUsersTable, organizationsTable,
} from "@workspace/db";
import { and, eq, desc, or, isNull, isNotNull, lt, sql, inArray } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireConsent } from "../lib/consent";
import { getObjectAclPolicy } from "../lib/objectAcl";
import { sendBroadcastEmail } from "../lib/mailer";
import { probeMediaDurationSeconds } from "../lib/mediaDurationProbe";

function getHmacSecret(): string {
  const secret = process.env["PRIVATE_OBJECT_DIR"];
  if (!secret) throw new Error("PRIVATE_OBJECT_DIR env var is required for upload token signing");
  return secret;
}

function signUploadPath(objectPath: string): string {
  return createHmac("sha256", getHmacSecret()).update(objectPath).digest("hex");
}

function verifyUploadToken(objectPath: string, token: string): boolean {
  try {
    return signUploadPath(objectPath) === token;
  } catch {
    return false; // secret not configured — reject all tokens
  }
}

const router: IRouter = Router();
const storage = new ObjectStorageService();

/** Download a video, check its duration with ffprobe, and generate a JPEG thumbnail.
 *  Throws with message "VIDEO_TOO_LONG" when duration exceeds maxSeconds.
 *  Throws with message "VIDEO_UNVERIFIABLE" when duration cannot be determined (fail-closed). */
async function processVideoUpload(videoObjectPath: string, maxSeconds = 60): Promise<{ thumbnailPath: string | null; durationSeconds: number | null }> {
  const tmpDir = tmpdir();
  const uid = randomUUID();
  const tmpVideo = path.join(tmpDir, `${uid}_src.mp4`);
  const tmpThumb = path.join(tmpDir, `${uid}_thumb.jpg`);
  try {
    // 1. Download the video from object storage to a temp file (single download for both checks)
    const videoFile = await storage.getObjectEntityFile(videoObjectPath);
    const nodeStream = videoFile.createReadStream();
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(tmpVideo);
      nodeStream.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      nodeStream.on("error", reject);
    });

    // 2. Check duration with ffprobe — fail closed if duration cannot be determined
    const duration = await new Promise<number | null>((resolve) => {
      let out = "";
      const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", tmpVideo]);
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 15000);
      proc.on("close", () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(out) as { streams?: Array<{ codec_type: string; duration?: string }> };
          const vs = data.streams?.find(s => s.codec_type === "video");
          resolve(vs?.duration ? parseFloat(vs.duration) : null);
        } catch { resolve(null); }
      });
    });

    // Fail closed: if duration cannot be determined we must reject, not silently allow
    if (duration === null) throw new Error("VIDEO_UNVERIFIABLE");
    if (duration > maxSeconds) throw new Error("VIDEO_TOO_LONG");

    // 3. Run ffmpeg to extract the first frame as a JPEG
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-i", tmpVideo, "-vframes", "1", "-f", "image2", "-y", tmpThumb]);
      const timer = setTimeout(() => { proc.kill(); reject(new Error("ffmpeg timeout")); }, 25000);
      proc.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
    });

    // 4. Upload the JPEG thumbnail to private object storage
    const thumbBuffer = readFileSync(tmpThumb);
    const thumbnailPath = await storage.saveRawBuffer(`thumbs/${uid}.jpg`, thumbBuffer, "image/jpeg");
    // Round up so a 7.4s video reports 8s — the editor uses this to
    // disable the start/length steppers, and rounding down would make the
    // last fraction of a second unreachable.
    const durationSeconds = duration != null ? Math.max(1, Math.ceil(duration)) : null;
    return { thumbnailPath, durationSeconds };
  } catch (e) {
    // Re-throw VIDEO_TOO_LONG / VIDEO_UNVERIFIABLE so the caller can return a 400
    if (e instanceof Error && (e.message === "VIDEO_TOO_LONG" || e.message === "VIDEO_UNVERIFIABLE")) throw e;
    // Any other processing error (storage, ffmpeg, etc.) — fail closed
    throw new Error("VIDEO_UNVERIFIABLE");
  } finally {
    try { unlinkSync(tmpVideo); } catch { /* ignore */ }
    try { unlinkSync(tmpThumb); } catch { /* ignore */ }
  }
}

function isAdmin(role?: string) {
  return ["super_admin", "org_admin", "tournament_director"].includes(role ?? "");
}

function userFromReq(req: Request) {
  return req.user as { id?: number; role?: string; organizationId?: number; displayName?: string; username?: string } | undefined;
}

function hasOrgAccess(caller: ReturnType<typeof userFromReq>, orgId: number): boolean {
  if (!caller?.id) return false;
  return caller.role === "super_admin" || caller.organizationId === orgId;
}

function hasOrgAdminAccess(caller: ReturnType<typeof userFromReq>, orgId: number): boolean {
  if (!caller?.id) return false;
  if (!isAdmin(caller.role)) return false;
  return caller.role === "super_admin" || caller.organizationId === orgId;
}

async function isRegisteredPlayer(userId: number, tournamentId: number): Promise<boolean> {
  const [p] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, userId)))
    .limit(1);
  return !!p;
}

async function isLeagueMember(userId: number, leagueId: number): Promise<boolean> {
  const [m] = await db
    .select({ id: leagueMembersTable.id })
    .from(leagueMembersTable)
    .where(and(eq(leagueMembersTable.leagueId, leagueId), eq(leagueMembersTable.userId, userId)))
    .limit(1);
  return !!m;
}

// Can caller read/upload media for this entity?
// Org admins can access all; regular org members must be registered players/league members.
async function canAccessMedia(
  caller: ReturnType<typeof userFromReq>,
  orgId: number,
  tournamentId?: number | null,
  leagueId?: number | null,
): Promise<boolean> {
  if (!caller?.id) return false;
  if (hasOrgAdminAccess(caller, orgId)) return true;
  if (tournamentId) return isRegisteredPlayer(caller.id, tournamentId);
  if (leagueId) return isLeagueMember(caller.id, leagueId);
  return false;
}

// Resolve moderation setting for an entity (default: true = moderation required)
async function getModerationEnabled(tournamentId?: number | null, leagueId?: number | null): Promise<boolean> {
  if (tournamentId) {
    const [t] = await db
      .select({ mediaModerationEnabled: tournamentsTable.mediaModerationEnabled })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId))
      .limit(1);
    return t?.mediaModerationEnabled ?? true;
  }
  if (leagueId) {
    const [l] = await db
      .select({ mediaModerationEnabled: leaguesTable.mediaModerationEnabled })
      .from(leaguesTable)
      .where(eq(leaguesTable.id, leagueId))
      .limit(1);
    return l?.mediaModerationEnabled ?? true;
  }
  return true;
}

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/quicktime", "video/x-m4v", "video/webm",
];

// POST /api/organizations/:orgId/media/upload-url
router.post("/organizations/:orgId/media/upload-url", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  // Task #469 — block media upload when the member has withdrawn photo OR video consent.
  // We don't yet know which one will be uploaded, so the strictest of the two applies:
  // if either is denied we block. Either deny denies the upload-url; the registration
  // endpoint re-checks against the resolved media type.
  if (!await requireConsent(req, res, "photo")) return;
  if (!await requireConsent(req, res, "video")) return;

  const { tournamentId, leagueId, contentType, size } = req.body;
  const tId = tournamentId ? parseInt(tournamentId) : null;
  const lId = leagueId ? parseInt(leagueId) : null;

  // Server-side file size enforcement (100 MB)
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  if (size !== undefined && typeof size === "number" && size > MAX_FILE_SIZE) {
    res.status(400).json({ error: "File too large. Maximum size is 100 MB." }); return;
  }

  // Validate content type if provided
  if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
    res.status(400).json({ error: "Unsupported media type. Allowed: JPEG, PNG, GIF, WebP, MP4, MOV, WebM" }); return;
  }

  // Validate entity belongs to organization (prevents cross-org object storage abuse)
  if (tId) {
    const [t] = await db.select({ id: tournamentsTable.id }).from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tId), eq(tournamentsTable.organizationId, orgId))).limit(1);
    if (!t) { { res.status(403).json({ error: "Tournament not found in this organization" }); return; } }
  }
  if (lId) {
    const [l] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
      .where(and(eq(leaguesTable.id, lId), eq(leaguesTable.organizationId, orgId))).limit(1);
    if (!l) { { res.status(403).json({ error: "League not found in this organization" }); return; } }
  }

  if (!await canAccessMedia(caller, orgId, tId, lId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    const uploadToken = signUploadPath(objectPath);
    res.json({ uploadURL, objectPath, uploadToken });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// POST /api/organizations/:orgId/media
// Register a completed upload
router.post("/organizations/:orgId/media", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { tournamentId, leagueId, objectPath, uploadToken, caption } = req.body;
  if (!objectPath || typeof objectPath !== "string") {
    res.status(400).json({ error: "objectPath required" }); return;
  }

  // Verify that objectPath was issued by this server (prevents IDOR / path injection)
  if (!uploadToken || !verifyUploadToken(objectPath, uploadToken)) {
    res.status(403).json({ error: "Invalid or missing upload token" }); return;
  }

  const tId = tournamentId ? parseInt(tournamentId) : null;
  const lId = leagueId ? parseInt(leagueId) : null;

  if (!await canAccessMedia(caller, orgId, tId, lId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  // Validate entity ownership
  if (tId) {
    const [t] = await db
      .select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tId), eq(tournamentsTable.organizationId, orgId)))
      .limit(1);
    if (!t) { { res.status(404).json({ error: "Tournament not found in this organization" }); return; } }
  }
  if (lId) {
    const [l] = await db
      .select({ id: leaguesTable.id })
      .from(leaguesTable)
      .where(and(eq(leaguesTable.id, lId), eq(leaguesTable.organizationId, orgId)))
      .limit(1);
    if (!l) { { res.status(404).json({ error: "League not found in this organization" }); return; } }
  }

  // Derive media type AND enforce file size from the stored object's actual metadata
  let storedContentType = "application/octet-stream";
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
  try {
    const objFile = await storage.getObjectEntityFile(objectPath);
    const [meta] = await objFile.getMetadata();
    storedContentType = (meta.contentType as string) || storedContentType;
    // Enforce file size from server-side metadata (not client-supplied body field)
    const storedSize = meta.size ? Number(meta.size) : 0;
    if (storedSize > MAX_BYTES) {
      res.status(400).json({ error: "File exceeds the 100 MB maximum size" }); return;
    }
  } catch { /* if metadata fetch fails, keep defaults and proceed — video will still be blocked by processVideoUpload */ }

  // Normalise: anything starting with "video/" is treated as video
  const isVideo = storedContentType.startsWith("video/");
  const mediaType = isVideo ? "video" : "image";

  // Task #469 — re-check consent against the resolved media type at registration
  // time so toggling consent between upload-url and POST is honoured.
  if (!await requireConsent(req, res, isVideo ? "video" : "photo")) return;

  // Determine approval: if moderation is enabled, ALL uploads start as pending
  const moderationEnabled = await getModerationEnabled(tId, lId);
  const approved = !moderationEnabled; // auto-approve when moderation is off

  const displayName = caller.displayName || caller.username || "Anonymous";

  // For videos: check duration server-side (60s limit, fail-closed) and generate thumbnail
  let thumbnailPath: string | null = null;
  let durationSeconds: number | null = null;
  if (isVideo) {
    try {
      const result = await processVideoUpload(objectPath);
      thumbnailPath = result.thumbnailPath;
      durationSeconds = result.durationSeconds;
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg === "VIDEO_TOO_LONG") {
        res.status(400).json({ error: "Video exceeds the 60-second maximum duration" }); return;
      }
      // VIDEO_UNVERIFIABLE or any other error: fail closed — do not store an unverified video
      res.status(400).json({ error: "Video could not be processed or verified. Please try again with a shorter clip." }); return;
    }
  }

  const [inserted] = await db.insert(mediaTable).values({
    organizationId: orgId,
    tournamentId: tId ?? null,
    leagueId: lId ?? null,
    uploadedByUserId: caller.id,
    uploaderName: displayName,
    objectPath,
    thumbnailPath,
    mediaType,
    durationSeconds,
    caption: caption ?? null,
    approved,
  }).returning();

  res.status(201).json(inserted);
});

// GET /api/organizations/:orgId/media
// Anonymous: ONLY tournament-scoped approved media (tournamentId required).
// League media: authentication + league membership or admin.
// All-org query (no entity filter): admin only.
router.get("/organizations/:orgId/media", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const tId = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;
  const lId = req.query.leagueId ? parseInt(req.query.leagueId as string) : null;

  // Rule 1: anonymous access is only allowed for tournament-scoped queries
  if (!caller?.id && !tId) {
    res.status(401).json({ error: "Authentication required" }); return;
  }

  // Rule 2: league media always requires authentication
  if (lId && !caller?.id) { { res.status(401).json({ error: "Authentication required to view league media" }); return; } }

  const adminUser = hasOrgAdminAccess(caller, orgId);
  const canAccess = caller?.id ? await canAccessMedia(caller, orgId, tId, lId) : false;

  // Rule 3: league media — only members or admins
  if (lId && !adminUser && !canAccess) { { res.status(403).json({ error: "League membership required" }); return; } }

  // Rule 4: all-org query (no entity filter) — admin only
  if (!tId && !lId && !adminUser) { { res.status(403).json({ error: "Admin access required to list all org media" }); return; } }

  const conditions = [eq(mediaTable.organizationId, orgId)];
  if (!adminUser) conditions.push(eq(mediaTable.approved, true));
  if (tId) conditions.push(eq(mediaTable.tournamentId, tId));
  if (lId) conditions.push(eq(mediaTable.leagueId, lId));

  // For non-admin entity members: also show their own pending uploads
  const items = await db
    .select()
    .from(mediaTable)
    .where(and(...conditions))
    .orderBy(desc(mediaTable.createdAt))
    .limit(200);

  // If caller is a non-admin entity member, include their own pending items too
  if (!adminUser && canAccess && caller?.id) {
    const ownPending = await db
      .select()
      .from(mediaTable)
      .where(and(
        eq(mediaTable.organizationId, orgId),
        eq(mediaTable.uploadedByUserId, caller.id),
        eq(mediaTable.approved, false),
        ...(tId ? [eq(mediaTable.tournamentId, tId)] : []),
        ...(lId ? [eq(mediaTable.leagueId, lId)] : []),
      ))
      .orderBy(desc(mediaTable.createdAt))
      .limit(50);
    const existingIds = new Set(items.map(i => i.id));
    const merged = [...items, ...ownPending.filter(i => !existingIds.has(i.id))];
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(merged);
    return;
  }

  res.json(items);
});

// GET /api/organizations/:orgId/media/unverifiable-videos
// Surfaces legacy video rows (Task #993) whose duration the backfill
// (Task #855) could not determine — i.e. duration_seconds is still NULL.
// Without a known duration the mobile highlight editor cannot trim them
// safely (it would silently fall back to a 30s window), so admins need a
// way to spot the affected rows and either re-upload or delete them.
//
// Task #1584: only return rows the background `recheckLegacyVideoDurations`
// cron has already given up on (durationUnverifiableReason IS NOT NULL).
// Rows the cron is still auto-retrying are intentionally hidden so admins
// only see things that genuinely need their attention. The
// `autoRecheckCount` field powers the "auto-retried N times" badge.
//
// Admin-only.
router.get("/organizations/:orgId/media/unverifiable-videos", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const ITEMS_LIMIT = 500;
  const whereClause = and(
    eq(mediaTable.organizationId, orgId),
    eq(mediaTable.mediaType, "video"),
    isNull(mediaTable.durationSeconds),
    isNotNull(mediaTable.durationUnverifiableReason),
  );

  // True total count (not just the page size) so admins can see the full
  // backlog even when there are more than ITEMS_LIMIT broken rows.
  const [{ totalCount }] = await db
    .select({ totalCount: sql<number>`count(*)::int` })
    .from(mediaTable)
    .where(whereClause);

  // Task #1598: left-join the uploader so the admin UI can filter rows by
  // the uploader's email as well as their display name. The join is left
  // (not inner) because uploadedByUserId may be NULL for very old rows or
  // when the original uploader account has been deleted.
  const rows = await db
    .select({
      id: mediaTable.id,
      objectPath: mediaTable.objectPath,
      thumbnailPath: mediaTable.thumbnailPath,
      uploaderName: mediaTable.uploaderName,
      uploadedByUserId: mediaTable.uploadedByUserId,
      uploaderEmail: appUsersTable.email,
      tournamentId: mediaTable.tournamentId,
      leagueId: mediaTable.leagueId,
      caption: mediaTable.caption,
      approved: mediaTable.approved,
      createdAt: mediaTable.createdAt,
      // Task #1327: surfaces the most recent re-probe attempt (manual
      // or cron) so the admin UI can show a "last attempted" timestamp.
      durationLastCheckedAt: mediaTable.durationLastCheckedAt,
      // Task #1584: powers the "auto-retried N times" badge + the
      // "object missing" / "permanently unverifiable" copy on each row.
      autoRecheckCount: mediaTable.durationAutoRecheckCount,
      unverifiableReason: mediaTable.durationUnverifiableReason,
    })
    .from(mediaTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, mediaTable.uploadedByUserId))
    .where(whereClause)
    .orderBy(desc(mediaTable.createdAt))
    .limit(ITEMS_LIMIT);

  // Task #1990 — surface the per-uploader re-upload nudge cooldown on
  // each row so the admin UI can disable the "Mark for re-upload" button
  // (and preview how many bulk-selected rows will be skipped) without
  // discovering the cooldown only after the bulk action returns. We
  // share the value across every row owned by the same uploader by
  // looking up MAX(media.last_reupload_request_at) per uploader in this
  // org — the same scope the request-reupload endpoints rate-limit on.
  const visibleUploaderIds = Array.from(new Set(
    rows.map((r) => r.uploadedByUserId).filter((v): v is number => v != null),
  ));
  const lastNudgedByUploader = new Map<number, Date>();
  if (visibleUploaderIds.length > 0) {
    const nudgeRows = await db
      .select({
        uploadedByUserId: mediaTable.uploadedByUserId,
        lastNudgedAt: sql<Date | null>`MAX(${mediaTable.lastReuploadRequestAt})`,
      })
      .from(mediaTable)
      .where(and(
        eq(mediaTable.organizationId, orgId),
        inArray(mediaTable.uploadedByUserId, visibleUploaderIds),
        isNotNull(mediaTable.lastReuploadRequestAt),
      ))
      .groupBy(mediaTable.uploadedByUserId);
    for (const r of nudgeRows) {
      if (r.uploadedByUserId != null && r.lastNudgedAt) {
        lastNudgedByUploader.set(r.uploadedByUserId, new Date(r.lastNudgedAt));
      }
    }
  }
  const items = rows.map((r) => ({
    ...r,
    uploaderLastNudgedAt: r.uploadedByUserId != null
      ? (lastNudgedByUploader.get(r.uploadedByUserId)?.toISOString() ?? null)
      : null,
  }));

  res.json({
    count: totalCount,
    items,
    truncated: totalCount > items.length,
    limit: ITEMS_LIMIT,
    // Task #1972 — surface the per-row re-check cooldown so the admin UI
    // can disable the button (and tick down a "available in Ns" hint) for
    // each row inside the window without hard-coding the 60s. The actual
    // 429 enforcement still lives on the recheck-duration endpoint.
    cooldownSeconds: RECHECK_COOLDOWN_SECONDS,
    // Task #1990 — surface the per-uploader re-upload nudge cooldown
    // window (in hours) so the admin UI can phrase its "wait N hours"
    // hint and the bulk-action confirm dialog without hard-coding the
    // 24h policy. The actual rate-limit enforcement still lives on the
    // request-reupload endpoints.
    reuploadCooldownHours: REUPLOAD_REQUEST_COOLDOWN_HOURS,
  });
});

// Task #1583 — Cooldown between successive re-checks of the same media
// row. Each probe downloads the video and runs ffprobe, so a fast-clicking
// admin (or a noisy auto-refresh) could otherwise hammer object storage
// for no benefit. We refuse to re-probe within this window and tell the
// admin to wait. The bulk "recheck all" endpoint also honours this so a
// quick second click can't reset the protection.
const RECHECK_COOLDOWN_SECONDS = 60;

// Task #1597 — per-uploader cooldown for the re-upload nudge email.
// Both the per-row and bulk request-reupload endpoints check
// MAX(media.last_reupload_request_at) for the uploader's rows in the
// org and refuse another nudge until this many hours have elapsed.
// Picked at one nudge / day so an admin sweeping the same backlog twice
// in a row, or two admins working the same list, can't pile multiple
// emails on the same player in quick succession.
const REUPLOAD_REQUEST_COOLDOWN_HOURS = 24;
const REUPLOAD_REQUEST_COOLDOWN_MS = REUPLOAD_REQUEST_COOLDOWN_HOURS * 60 * 60 * 1000;

// How long until the next nudge for `uploaderLastNudgedAt` becomes
// allowed, in whole seconds (0 = no cooldown). Returned to the client
// as `retryAfterSeconds` so the UI can show a friendly countdown.
function reuploadCooldownRemainingSeconds(uploaderLastNudgedAt: Date | null | undefined): number {
  if (!uploaderLastNudgedAt) return 0;
  const elapsed = Date.now() - new Date(uploaderLastNudgedAt).getTime();
  if (elapsed >= REUPLOAD_REQUEST_COOLDOWN_MS) return 0;
  return Math.max(1, Math.ceil((REUPLOAD_REQUEST_COOLDOWN_MS - elapsed) / 1000));
}

function cooldownRemainingSeconds(lastCheckedAt: Date | string | null): number {
  if (!lastCheckedAt) return 0;
  const t = lastCheckedAt instanceof Date ? lastCheckedAt.getTime() : new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const elapsed = (Date.now() - t) / 1000;
  return Math.max(0, Math.ceil(RECHECK_COOLDOWN_SECONDS - elapsed));
}

// Task #1327 — Re-run the duration probe for a single legacy video row.
// Some Task #855 backfill failures were transient (ffprobe timeout, brief
// storage hiccup), so before bothering uploaders we let admins try the
// probe again on demand from the unverifiable-videos page.
//
// Outcomes:
//   - probe succeeds → write duration_seconds, clear duration_last_checked_at,
//                       respond { ok: true, recovered: true, durationSeconds }
//   - probe still fails → stamp duration_last_checked_at so the row stays
//                       in the list with a "last attempted" timestamp,
//                       respond { ok: true, recovered: false, reason }
//   - object missing  → distinct reason="object_missing" so the UI can
//                       suggest "delete the row instead" instead of
//                       implying the file is just slow today.
async function recheckSingleRow(rowId: number): Promise<
  | { recovered: true; durationSeconds: number }
  | { recovered: false; reason: "unverifiable" | "object_missing" | "probe_error"; error?: string }
> {
  const [row] = await db
    .select({ id: mediaTable.id, objectPath: mediaTable.objectPath })
    .from(mediaTable)
    .where(eq(mediaTable.id, rowId))
    .limit(1);
  if (!row) return { recovered: false, reason: "probe_error", error: "row vanished" };

  try {
    const durationSeconds = await probeMediaDurationSeconds(row.objectPath);
    if (durationSeconds === null) {
      // Stamp the attempt so the row still shows up in the list but
      // admins can see we already tried (and when). Note: we do NOT
      // bump duration_auto_recheck_count here — that counter is only
      // for background cron attempts (Task #1584). A manual admin
      // re-check that fails leaves the cron's give-up state intact.
      await db.update(mediaTable)
        .set({ durationLastCheckedAt: new Date() })
        .where(eq(mediaTable.id, rowId));
      return { recovered: false, reason: "unverifiable" };
    }
    // Recovered — also clear the cron's auto-retry bookkeeping so the
    // row drops off the unverifiable list (the GET filter requires
    // duration_unverifiable_reason IS NOT NULL).
    await db.update(mediaTable)
      .set({
        durationSeconds,
        durationLastCheckedAt: null,
        durationAutoRecheckCount: 0,
        durationUnverifiableReason: null,
      })
      .where(eq(mediaTable.id, rowId));
    return { recovered: true, durationSeconds };
  } catch (err) {
    await db.update(mediaTable)
      .set({ durationLastCheckedAt: new Date() })
      .where(eq(mediaTable.id, rowId));
    if (err instanceof ObjectNotFoundError) {
      return { recovered: false, reason: "object_missing" };
    }
    return { recovered: false, reason: "probe_error", error: (err as Error).message };
  }
}

// POST /api/organizations/:orgId/media/:mediaId/recheck-duration
// Single-row re-probe. Admin-only. Constrained to the same set of rows
// the unverifiable-videos endpoint surfaces (legacy video, NULL duration)
// so an admin can't accidentally re-probe an image or an already-good
// video by hand-crafting the URL.
router.post("/organizations/:orgId/media/:mediaId/recheck-duration", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  if (isNaN(mediaId)) { { res.status(400).json({ error: "Invalid mediaId" }); return; } }

  const [item] = await db.select().from(mediaTable).where(eq(mediaTable.id, mediaId)).limit(1);
  if (!item) { { res.status(404).json({ error: "Not found" }); return; } }
  if (item.organizationId !== orgId && caller?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (item.mediaType !== "video" || item.durationSeconds !== null) {
    res.status(409).json({ error: "Media is not an unverifiable video" });
    return;
  }

  // Task #1583 — refuse to re-probe within the cooldown so a fast-clicking
  // admin (or a noisy auto-refresh) can't hammer object storage. Returning
  // a 429 with `retryAfterSeconds` lets the UI show a friendly countdown.
  const remaining = cooldownRemainingSeconds(item.durationLastCheckedAt);
  if (remaining > 0) {
    res.setHeader("Retry-After", String(remaining));
    res.status(429).json({
      error: `Tried recently — try again in ${remaining} second${remaining === 1 ? "" : "s"}.`,
      reason: "rate_limited",
      retryAfterSeconds: remaining,
      cooldownSeconds: RECHECK_COOLDOWN_SECONDS,
    });
    return;
  }

  const result = await recheckSingleRow(mediaId);
  res.json({ ok: true, ...result });
});

// POST /api/organizations/:orgId/media/recheck-all-durations
// Top-of-page "Re-check all" — iterates over every legacy video in the org
// whose duration_seconds is still NULL and tries the probe one more time.
// Returns aggregate counts so the UI can surface "recovered N of M".
//
// Task #1584: scoped to rows the background cron has already given up on
// (durationUnverifiableReason IS NOT NULL) so this endpoint mirrors the
// admin "unverifiable videos" list exactly. Rows the cron is still
// auto-retrying don't need a manual nudge — and the cron's per-row
// backoff would skip them anyway, so a manual sweep across them would
// just waste an ffprobe pass.
//
// We cap at ITEMS_LIMIT so a runaway backlog can't pin the API server on
// a single request (each probe downloads + ffprobes the file). Admins
// can re-run if there are still rows after the cap.
router.post("/organizations/:orgId/media/recheck-all-durations", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const ITEMS_LIMIT = 50;

  // Task #1583 — skip rows that were probed within the cooldown window so
  // a quick second click of "Re-check all" can't reset the per-row
  // protection. We compute the cutoff once on the server side and let
  // SQL do the filtering.
  const cooldownCutoff = new Date(Date.now() - RECHECK_COOLDOWN_SECONDS * 1000);

  const rows = await db
    .select({ id: mediaTable.id })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      // Task #1584: only sweep rows the background cron has given up
      // on, so this admin "Re-check all" mirrors the unverifiable
      // videos list. Rows still being auto-retried by the cron don't
      // need a manual nudge.
      isNotNull(mediaTable.durationUnverifiableReason),
      // Task #1583: per-row cooldown so admins repeatedly clicking
      // "Re-check all" don't re-probe the same row faster than
      // RECHECK_COOLDOWN_SECONDS.
      or(
        isNull(mediaTable.durationLastCheckedAt),
        lt(mediaTable.durationLastCheckedAt, cooldownCutoff),
      ),
    ))
    .orderBy(desc(mediaTable.createdAt))
    .limit(ITEMS_LIMIT);

  // Count how many rows are still in cooldown (skipped this round) so the
  // UI can show "N skipped — recently checked" instead of the admin
  // wondering why fewer rows than expected were re-probed.
  const [{ skippedCooldown }] = await db
    .select({ skippedCooldown: sql<number>`count(*)::int` })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      sql`${mediaTable.durationLastCheckedAt} >= ${cooldownCutoff}`,
    ));

  let recovered = 0;
  let stillFailing = 0;
  let objectMissing = 0;
  for (const row of rows) {
    const r = await recheckSingleRow(row.id);
    if (r.recovered) recovered++;
    else if (r.reason === "object_missing") { stillFailing++; objectMissing++; }
    else stillFailing++;
  }

  res.json({
    ok: true,
    attempted: rows.length,
    recovered,
    stillFailing,
    objectMissing,
    skippedCooldown,
    cooldownSeconds: RECHECK_COOLDOWN_SECONDS,
    limit: ITEMS_LIMIT,
  });
});

// POST /api/organizations/:orgId/media/:mediaId/request-reupload
// Companion to GET .../media/unverifiable-videos. Lets an admin nudge the
// original uploader to re-submit a video whose duration we couldn't measure
// (the highlight editor can't trim those rows safely). We don't auto-delete
// because the admin may want to keep a record until the new upload arrives.
// Sends an email if the uploader has one on file; otherwise returns a flag so
// the UI can fall back to deleting the row by hand.
router.post("/organizations/:orgId/media/:mediaId/request-reupload", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  if (isNaN(mediaId)) { { res.status(400).json({ error: "Invalid mediaId" }); return; } }

  const [item] = await db.select().from(mediaTable).where(eq(mediaTable.id, mediaId)).limit(1);
  if (!item) { { res.status(404).json({ error: "Not found" }); return; } }
  if (item.organizationId !== orgId && caller?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  // Constrain to the rows this endpoint is meant to act on: legacy videos
  // whose duration we couldn't measure. Prevents an admin from accidentally
  // pinging an uploader about a perfectly fine image or already-trimmed
  // video by hand-crafting a request.
  if (item.mediaType !== "video" || item.durationSeconds !== null) {
    res.status(409).json({ error: "Media is not an unverifiable video" });
    return;
  }

  if (!item.uploadedByUserId) {
    res.json({ ok: true, emailed: false, reason: "uploader_unknown" });
    return;
  }

  const [uploader] = await db
    .select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, item.uploadedByUserId))
    .limit(1);

  if (!uploader?.email) {
    res.json({ ok: true, emailed: false, reason: "no_email" });
    return;
  }

  // Task #1597 — share the per-uploader rate limit with the bulk endpoint
  // so an admin clicking individual rows can't outpace the bulk
  // protection. Look at MAX(last_reupload_request_at) across all of this
  // uploader's rows in this org and refuse if we nudged them within the
  // cooldown.
  const [latestNudge] = await db
    .select({
      lastNudgedAt: sql<Date | null>`MAX(${mediaTable.lastReuploadRequestAt})`,
    })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      eq(mediaTable.uploadedByUserId, uploader.id),
    ));
  const remaining = reuploadCooldownRemainingSeconds(latestNudge?.lastNudgedAt ?? null);
  if (remaining > 0) {
    res.json({
      ok: true,
      emailed: false,
      reason: "rate_limited",
      retryAfterSeconds: remaining,
      cooldownHours: REUPLOAD_REQUEST_COOLDOWN_HOURS,
    });
    return;
  }

  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);

  const orgName = org?.name ?? "KHARAGOLF";
  const uploadedAt = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "an earlier date";
  const captionLine = item.caption ? `\nOriginal caption: "${item.caption}"\n` : "";
  const body =
    `One of your video uploads from ${uploadedAt} couldn't be processed by our highlight editor — we weren't able to measure its length, so it can't be trimmed or shared.\n` +
    captionLine +
    `\nPlease open the app and re-upload the clip when you have a moment. The original entry will be removed once the new upload is in.\n`;

  try {
    await sendBroadcastEmail(
      uploader.email,
      uploader.displayName ?? "there",
      "Please re-upload your video",
      body,
      orgName,
      { orgName },
    );
    // Task #1597 — stamp this row so the per-uploader cooldown applies
    // on the next call (per-row or bulk). Best-effort: an email already
    // went out, so a stamp failure shouldn't 500 the request, but it
    // would let the cooldown be bypassed, so we surface a 502.
    try {
      await db
        .update(mediaTable)
        .set({ lastReuploadRequestAt: new Date() })
        .where(eq(mediaTable.id, mediaId));
    } catch (err) {
      res.status(502).json({
        error: "Email sent but cooldown stamp failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.json({ ok: true, emailed: true });
  } catch (err) {
    res.status(502).json({ error: "Email send failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/organizations/:orgId/media/unverifiable-videos/bulk-delete
// Bulk companion to DELETE /media/:mediaId for the Video Cleanup screen
// (Task #1326). Accepts an array of mediaIds and deletes each one in a
// single sweep, returning per-row success/error counts so the admin can
// see exactly which rows survived. Mirrors the response shape of
// /marketing-site/course-photos/moderate-bulk.
//
// Restricted to legacy "unverifiable" rows (mediaType='video' AND
// durationSeconds IS NULL) so a malformed/handcrafted request can't be
// used to wipe out perfectly fine images or already-trimmed videos via
// the Video Cleanup endpoint.
router.post("/organizations/:orgId/media/unverifiable-videos/bulk-delete", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const rawIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "mediaIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot delete more than 200 videos in one request." }); return;
  }

  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid mediaIds supplied." }); return; } }

  const existing = await db.select().from(mediaTable)
    .where(and(eq(mediaTable.organizationId, orgId), inArray(mediaTable.id, ids)));
  const byId = new Map(existing.map((m) => [m.id, m]));

  const deleted: Array<{ id: number }> = [];
  const errors: Array<{ mediaId: number; error: string }> = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { errors.push({ mediaId: id, error: "Video not found in this organization." }); continue; }
    if (row.mediaType !== "video" || row.durationSeconds !== null) {
      errors.push({ mediaId: id, error: "Media is not an unverifiable video." }); continue;
    }
    try {
      const r = await db.delete(mediaTable)
        .where(and(
          eq(mediaTable.id, id),
          eq(mediaTable.organizationId, orgId),
          eq(mediaTable.mediaType, "video"),
          isNull(mediaTable.durationSeconds),
        ))
        .returning({ id: mediaTable.id });
      if (!r.length) { errors.push({ mediaId: id, error: "Video state changed before it could be deleted." }); continue; }
      deleted.push({ id: r[0].id });
    } catch {
      errors.push({ mediaId: id, error: "Internal error while deleting this video." });
    }
  }

  res.json({
    deletedCount: deleted.length,
    errorCount: errors.length,
    action: "delete",
    deleted,
    errors,
  });
});

// POST /api/organizations/:orgId/media/unverifiable-videos/bulk-request-reupload
// Bulk companion to POST /media/:mediaId/request-reupload for the Video
// Cleanup screen (Task #1326). Per-row outcomes are returned so the UI can
// show which rows were emailed vs. skipped (no_email / uploader_unknown /
// rate_limited) vs. failed (send error / state mismatch).
//
// Task #1597 — protect uploaders from accidental email blasts:
//   * rows are grouped by uploader and a SINGLE email is sent per
//     uploader listing all of their selected broken clips, instead of
//     one email per mediaId. An admin selecting "all" on a club with
//     hundreds of broken legacy uploads now sends at most one email
//     per uploader per click.
//   * a per-uploader cooldown (REUPLOAD_REQUEST_COOLDOWN_HOURS) is
//     enforced across calls by reading
//     MAX(media.last_reupload_request_at) for each uploader's rows in
//     this org. Uploaders nudged within the cooldown have their
//     selected rows reported as `skipped` with `reason: "rate_limited"`
//     and a `retryAfterSeconds` so the UI can tell the admin when the
//     next nudge will be allowed.
//   * the `emailed` array still lists every mediaId covered by an
//     email so the UI can drop those rows from the selection. The
//     companion `uploadersEmailedCount` reports how many actual
//     emails went out (always <= emailedCount).
router.post("/organizations/:orgId/media/unverifiable-videos/bulk-request-reupload", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const rawIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "mediaIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot nudge more than 200 videos in one request." }); return;
  }

  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid mediaIds supplied." }); return; } }

  const existing = await db.select().from(mediaTable)
    .where(and(eq(mediaTable.organizationId, orgId), inArray(mediaTable.id, ids)));
  const byId = new Map(existing.map((m) => [m.id, m]));

  // Resolve uploader emails in one query rather than once per row.
  const uploaderIds = Array.from(new Set(
    existing.map((m) => m.uploadedByUserId).filter((v): v is number => v != null),
  ));
  const uploaders = uploaderIds.length > 0
    ? await db
      .select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, uploaderIds))
    : [];
  const uploaderById = new Map(uploaders.map((u) => [u.id, u]));

  // Task #1597 — fetch the most recent re-upload nudge per uploader in
  // this org in one query so we can rate-limit before sending. We scan
  // the uploader's rows (not just the selected ones) so a fresh selection
  // of "different" rows for the same uploader still respects the
  // cooldown set by an earlier call.
  const recentNudges = uploaderIds.length > 0
    ? await db
      .select({
        uploadedByUserId: mediaTable.uploadedByUserId,
        lastNudgedAt: sql<Date | null>`MAX(${mediaTable.lastReuploadRequestAt})`,
      })
      .from(mediaTable)
      .where(and(
        eq(mediaTable.organizationId, orgId),
        inArray(mediaTable.uploadedByUserId, uploaderIds),
        isNotNull(mediaTable.lastReuploadRequestAt),
      ))
      .groupBy(mediaTable.uploadedByUserId)
    : [];
  const lastNudgedByUploader = new Map<number, Date>();
  for (const r of recentNudges) {
    if (r.uploadedByUserId != null && r.lastNudgedAt) {
      lastNudgedByUploader.set(r.uploadedByUserId, new Date(r.lastNudgedAt));
    }
  }

  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const orgName = org?.name ?? "KHARAGOLF";

  const emailed: Array<{ id: number }> = [];
  const skipped: Array<{
    mediaId: number;
    reason: "no_email" | "uploader_unknown" | "rate_limited";
    retryAfterSeconds?: number;
  }> = [];
  const errors: Array<{ mediaId: number; error: string }> = [];

  // Walk the requested ids once to validate and bucket them by uploader.
  // `groups` keeps insertion order so rows within an email body line up
  // with the order the admin selected them.
  const groups = new Map<number, { uploader: typeof uploaders[number]; items: typeof existing }>();

  for (const id of ids) {
    const item = byId.get(id);
    if (!item) { errors.push({ mediaId: id, error: "Video not found in this organization." }); continue; }
    if (item.mediaType !== "video" || item.durationSeconds !== null) {
      errors.push({ mediaId: id, error: "Media is not an unverifiable video." }); continue;
    }
    if (!item.uploadedByUserId) {
      skipped.push({ mediaId: id, reason: "uploader_unknown" }); continue;
    }
    const uploader = uploaderById.get(item.uploadedByUserId);
    if (!uploader?.email) {
      skipped.push({ mediaId: id, reason: "no_email" }); continue;
    }
    let bucket = groups.get(uploader.id);
    if (!bucket) {
      bucket = { uploader, items: [] };
      groups.set(uploader.id, bucket);
    }
    bucket.items.push(item);
  }

  // Send one email per uploader (de-dup), honouring the per-uploader
  // cooldown. Bumping last_reupload_request_at on every covered row
  // keeps the cooldown shared between the per-row and bulk paths.
  let uploadersEmailedCount = 0;
  for (const { uploader, items } of groups.values()) {
    const remaining = reuploadCooldownRemainingSeconds(lastNudgedByUploader.get(uploader.id) ?? null);
    if (remaining > 0) {
      for (const it of items) {
        skipped.push({ mediaId: it.id, reason: "rate_limited", retryAfterSeconds: remaining });
      }
      continue;
    }

    // Build the email body. With one video, mirror the per-row endpoint
    // exactly. With multiple, list them so the uploader can match each
    // entry to a clip in their library.
    let body: string;
    if (items.length === 1) {
      const it = items[0];
      const uploadedAt = it.createdAt ? new Date(it.createdAt).toLocaleDateString() : "an earlier date";
      const captionLine = it.caption ? `\nOriginal caption: "${it.caption}"\n` : "";
      body =
        `One of your video uploads from ${uploadedAt} couldn't be processed by our highlight editor — we weren't able to measure its length, so it can't be trimmed or shared.\n` +
        captionLine +
        `\nPlease open the app and re-upload the clip when you have a moment. The original entry will be removed once the new upload is in.\n`;
    } else {
      const lines = items.map((it) => {
        const uploadedAt = it.createdAt ? new Date(it.createdAt).toLocaleDateString() : "an earlier date";
        const caption = it.caption ? ` — "${it.caption}"` : "";
        return `  • Uploaded ${uploadedAt}${caption}`;
      }).join("\n");
      body =
        `${items.length} of your video uploads couldn't be processed by our highlight editor — we weren't able to measure their length, so they can't be trimmed or shared:\n\n` +
        `${lines}\n\n` +
        `Please open the app and re-upload these clips when you have a moment. The original entries will be removed once the new uploads are in.\n`;
    }

    try {
      await sendBroadcastEmail(
        uploader.email!,
        uploader.displayName ?? "there",
        items.length === 1 ? "Please re-upload your video" : `Please re-upload ${items.length} videos`,
        body,
        orgName,
        { orgName },
      );
      uploadersEmailedCount++;
      const nudgedIds = items.map((it) => it.id);
      try {
        await db
          .update(mediaTable)
          .set({ lastReuploadRequestAt: new Date() })
          .where(and(
            eq(mediaTable.organizationId, orgId),
            inArray(mediaTable.id, nudgedIds),
          ));
      } catch (err) {
        // Same posture as the per-row endpoint: a stamp failure after
        // a successful send means the cooldown could be bypassed, so
        // surface it as an error rather than silently treating the
        // rows as nudged.
        for (const it of items) {
          errors.push({
            mediaId: it.id,
            error: `Email sent but cooldown stamp failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        continue;
      }
      for (const it of items) emailed.push({ id: it.id });
    } catch (err) {
      const msg = `Email send failed: ${err instanceof Error ? err.message : String(err)}`;
      for (const it of items) {
        errors.push({ mediaId: it.id, error: msg });
      }
    }
  }

  res.json({
    emailedCount: emailed.length,
    uploadersEmailedCount,
    skippedCount: skipped.length,
    errorCount: errors.length,
    cooldownHours: REUPLOAD_REQUEST_COOLDOWN_HOURS,
    action: "request-reupload",
    emailed,
    skipped,
    errors,
  });
});

// PATCH /api/organizations/:orgId/media/:mediaId/approve
router.patch("/organizations/:orgId/media/:mediaId/approve", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  const [item] = await db.select().from(mediaTable).where(eq(mediaTable.id, mediaId)).limit(1);
  if (!item) { { res.status(404).json({ error: "Not found" }); return; } }
  if (item.organizationId !== orgId && caller?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [updated] = await db
    .update(mediaTable)
    .set({ approved: true })
    .where(eq(mediaTable.id, mediaId))
    .returning();

  res.json(updated);
});

// PATCH /api/organizations/:orgId/tournaments/:entityId/media-moderation
// Toggle media moderation for a tournament
router.patch("/organizations/:orgId/tournaments/:entityId/media-moderation", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const entityId = parseInt(String((req.params as Record<string, string>).entityId));
  const [t] = await db.select().from(tournamentsTable).where(and(eq(tournamentsTable.id, entityId), eq(tournamentsTable.organizationId, orgId))).limit(1);
  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const enabled = req.body.enabled ?? !t.mediaModerationEnabled;
  const [updated] = await db
    .update(tournamentsTable)
    .set({ mediaModerationEnabled: enabled })
    .where(eq(tournamentsTable.id, entityId))
    .returning({ id: tournamentsTable.id, mediaModerationEnabled: tournamentsTable.mediaModerationEnabled });

  res.json(updated);
});

// PATCH /api/organizations/:orgId/leagues/:entityId/media-moderation
// Toggle media moderation for a league
router.patch("/organizations/:orgId/leagues/:entityId/media-moderation", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const entityId = parseInt(String((req.params as Record<string, string>).entityId));
  const [l] = await db.select().from(leaguesTable).where(and(eq(leaguesTable.id, entityId), eq(leaguesTable.organizationId, orgId))).limit(1);
  if (!l) { { res.status(404).json({ error: "League not found" }); return; } }

  const enabled = req.body.enabled ?? !l.mediaModerationEnabled;
  const [updated] = await db
    .update(leaguesTable)
    .set({ mediaModerationEnabled: enabled })
    .where(eq(leaguesTable.id, entityId))
    .returning({ id: leaguesTable.id, mediaModerationEnabled: leaguesTable.mediaModerationEnabled });

  res.json(updated);
});

// DELETE /api/organizations/:orgId/media/:mediaId
// Admins can delete any; uploaders can delete their own items
router.delete("/organizations/:orgId/media/:mediaId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  const [item] = await db.select().from(mediaTable).where(eq(mediaTable.id, mediaId)).limit(1);
  if (!item) { { res.status(404).json({ error: "Not found" }); return; } }
  if (item.organizationId !== orgId && caller.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const isOrgAdmin = hasOrgAdminAccess(caller, orgId);
  const isOwner = item.uploadedByUserId === caller.id;
  if (!isOrgAdmin && !isOwner) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(mediaTable).where(eq(mediaTable.id, mediaId));
  res.json({ ok: true });
});

// GET /api/storage/objects/{*objectPath}
// DENY BY DEFAULT — serves object only if media record exists and caller is authorized
// Security: approved league media requires membership; approved tournament media is public
router.get("/storage/objects/{*objectPath}", async (req: Request, res: Response) => {
  const rawParam = (req.params as Record<string, string>).objectPath ?? "";
  const objectPath = "/objects/" + rawParam;

  // Look up media record by either main objectPath or thumbnailPath
  const [mediaItem] = await db
    .select({
      approved: mediaTable.approved,
      organizationId: mediaTable.organizationId,
      uploadedByUserId: mediaTable.uploadedByUserId,
      leagueId: mediaTable.leagueId,
      tournamentId: mediaTable.tournamentId,
    })
    .from(mediaTable)
    .where(or(eq(mediaTable.objectPath, objectPath), eq(mediaTable.thumbnailPath, objectPath)))
    .limit(1);

  const caller = userFromReq(req);

  // Swing video ACL branch — registered swing videos & their annotations (voice-overs)
  if (!mediaItem) {
    const [swingHit] = await db
      .select({
        id: swingVideosTable.id,
        userId: swingVideosTable.userId,
        organizationId: swingVideosTable.organizationId,
      })
      .from(swingVideosTable)
      .where(or(
        eq(swingVideosTable.videoUrl, objectPath),
        eq(swingVideosTable.thumbnailUrl, objectPath),
      ))
      .limit(1);

    let swingVideoId: number | null = swingHit?.id ?? null;
    let swingOwnerId: number | null = swingHit?.userId ?? null;
    let swingOrgId: number | null = swingHit?.organizationId ?? null;

    if (!swingVideoId) {
      const [annHit] = await db
        .select({ swingVideoId: swingAnnotationsTable.swingVideoId })
        .from(swingAnnotationsTable)
        .where(eq(swingAnnotationsTable.voiceOverUrl, objectPath))
        .limit(1);
      if (annHit) {
        const [v] = await db
          .select({
            id: swingVideosTable.id,
            userId: swingVideosTable.userId,
            organizationId: swingVideosTable.organizationId,
          })
          .from(swingVideosTable)
          .where(eq(swingVideosTable.id, annHit.swingVideoId))
          .limit(1);
        if (v) {
          swingVideoId = v.id;
          swingOwnerId = v.userId;
          swingOrgId = v.organizationId;
        }
      }
    }

    if (!swingVideoId) {
      // swing_review_requests no longer carries a voice_over_url column —
      // voice overs are attached via swing_annotations (covered above).
      const reqHit: { swingVideoId: number } | undefined = undefined;
      if (reqHit) {
        const [v] = await db
          .select({
            id: swingVideosTable.id,
            userId: swingVideosTable.userId,
            organizationId: swingVideosTable.organizationId,
          })
          .from(swingVideosTable)
          .where(eq(swingVideosTable.id, (reqHit as { swingVideoId: number }).swingVideoId))
          .limit(1);
        if (v) {
          swingVideoId = v.id;
          swingOwnerId = v.userId;
          swingOrgId = v.organizationId;
        }
      }
    }

    if (!swingVideoId || swingOwnerId == null) {
      // Fallback: serve any object whose ACL policy is explicitly public.
      // Marketing-site assets (hero, OG, gallery) are stored this way so they
      // can be referenced from the public mini-site without a media row.
      try {
        const file = await storage.getObjectEntityFile(objectPath);
        const policy = await getObjectAclPolicy(file);
        if (policy?.visibility === "public") {
          const response = await storage.downloadObject(file, 3600);
          const body = response.body;
          const ct = response.headers.get("content-type") ?? "application/octet-stream";
          const cc = response.headers.get("cache-control") ?? "public, max-age=3600";
          res.setHeader("Content-Type", ct);
          res.setHeader("Cache-Control", cc);
          const cl = response.headers.get("content-length");
          if (cl) res.setHeader("Content-Length", cl);
          if (body) {
            const reader = body.getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) { { res.end(); return; } }
              res.write(Buffer.from(value));
              await pump();
            };
            await pump();
          } else {
            res.end();
          }
          return;
        }
      } catch { /* fall through to 404 */ }
      res.status(404).json({ error: "Not found" }); return;
    }

    if (!caller?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
    const isOwner = caller.id === swingOwnerId;
    const isAdmin = swingOrgId != null && hasOrgAdminAccess(caller, swingOrgId);
    let isAssignedCoach = false;
    if (!isOwner && !isAdmin) {
      const [coachLink] = await db
        .select({ id: swingReviewRequestsTable.id })
        .from(swingReviewRequestsTable)
        .innerJoin(teachingProsTable, eq(teachingProsTable.id, swingReviewRequestsTable.proId))
        .where(and(
          eq(swingReviewRequestsTable.swingVideoId, swingVideoId as number),
          eq(teachingProsTable.userId, caller.id),
        ))
        .limit(1);
      isAssignedCoach = !!coachLink;
    }
    if (!isOwner && !isAdmin && !isAssignedCoach) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    try {
      const file = await storage.getObjectEntityFile(objectPath);
      const response = await storage.downloadObject(file, 3600);
      const body = response.body;
      const ct = response.headers.get("content-type") ?? "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "private, max-age=3600");
      const cl = response.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      if (body) {
        const reader = body.getReader();
        const pump = async () => {
          const { done, value } = await reader.read();
          if (done) { { res.end(); return; } }
          res.write(Buffer.from(value));
          await pump();
        };
        await pump();
      } else {
        res.end();
      }
    } catch {
      res.status(404).json({ error: "Object not found" });
    }
    return;
  }

  const isOrgAdmin = hasOrgAdminAccess(caller, mediaItem.organizationId);

  if (!mediaItem.approved) {
    // Unapproved: require org admin or the uploader themselves
    const isOwner = caller?.id != null && caller.id === mediaItem.uploadedByUserId;
    if (!isOrgAdmin && !isOwner) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  } else if (mediaItem.leagueId != null) {
    // Approved league media: require authentication + league membership
    if (!caller?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
    if (!isOrgAdmin) {
      const isMember = await isLeagueMember(caller.id, mediaItem.leagueId);
      if (!isMember) { { res.status(403).json({ error: "League membership required" }); return; } }
    }
  }
  // Approved tournament media: public — no additional checks

  try {
    const file = await storage.getObjectEntityFile(objectPath);
    const response = await storage.downloadObject(file, 3600);
    const body = response.body;
    const ct = response.headers.get("content-type") ?? "application/octet-stream";
    const cc = response.headers.get("cache-control") ?? "private, max-age=3600";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", cc);
    const cl = response.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    if (body) {
      const reader = body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) { { res.end(); return; } }
        res.write(Buffer.from(value));
        await pump();
      };
      await pump();
    } else {
      res.end();
    }
  } catch {
    res.status(404).json({ error: "Object not found" });
  }
});

export default router;
