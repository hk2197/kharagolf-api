/**
 * Highlight Reels API (Task #361) — photo-to-video highlights for the social feed.
 *
 *   GET    /api/portal/highlight-templates              List available templates
 *   GET    /api/portal/highlights                       List my highlight reels
 *   GET    /api/portal/highlights/:id                   Get one
 *   POST   /api/portal/highlights                       Create + queue render
 *   PATCH  /api/portal/highlights/:id                   Update + re-render (only if not posted)
 *   DELETE /api/portal/highlights/:id                   Delete
 *   POST   /api/portal/highlights/:id/post-to-feed      Post a ready reel to the social feed
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  highlightReelsTable,
  highlightRenderEventsTable,
  highlightReelEngagementsTable,
  highlightCaptionTemplatesTable,
  feedPostsTable,
  feedPostMediaTable,
  mediaTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  holeDetailsTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { HIGHLIGHT_TEMPLATES, getTemplate, buildRoundSummary } from "../lib/highlightRender";
import { enqueueRender, getQueuePosition, getQueueDepth, MAX_ATTEMPTS, AVG_RENDER_SECONDS } from "../lib/highlightQueue";
import { logger } from "../lib/logger";
import { requireConsent } from "../lib/consent";
import { recordEmailConversionForRequest } from "../lib/emailCtaConversion";

const router: IRouter = Router();

type PortalReq = { portalUser?: { userId?: number; organizationId?: number } };

function getCaller(req: Request): { userId: number; organizationId: number | null } | null {
  if (req.isAuthenticated()) {
    const u = req.user as { id?: number; organizationId?: number };
    if (u?.id) return { userId: u.id, organizationId: u.organizationId ?? null };
  }
  const p = (req as unknown as PortalReq).portalUser;
  if (p?.userId) return { userId: p.userId, organizationId: p.organizationId ?? null };
  return null;
}

// Per-tier monthly render quotas — protects compute cost.
const MONTHLY_QUOTA: Record<string, number> = {
  free: 1,
  starter: 3,
  pro: 10,
  enterprise: 1_000_000,
};

async function quotaForOrg(orgId: number): Promise<number> {
  const [o] = await db
    .select({ tier: organizationsTable.subscriptionTier })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  return MONTHLY_QUOTA[o?.tier ?? "free"] ?? 1;
}

async function rendersThisMonth(userId: number, orgId: number): Promise<number> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  // Count render *events* (initial + every re-render) so that re-renders
  // also consume the per-tier monthly quota.
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(highlightRenderEventsTable)
    .where(and(
      eq(highlightRenderEventsTable.userId, userId),
      eq(highlightRenderEventsTable.organizationId, orgId),
      gte(highlightRenderEventsTable.createdAt, start),
    ));
  return Number(n ?? 0);
}

async function resolveOrgIdForCaller(req: Request, caller: { userId: number; organizationId: number | null }, fallback?: number | string | null): Promise<number | null> {
  if (caller.organizationId) return caller.organizationId;
  const fb = fallback ? Number(fallback) : null;
  if (fb && Number.isFinite(fb)) {
    // Verify caller is a member of fb
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, caller.userId), eq(orgMembershipsTable.organizationId, fb)))
      .limit(1);
    if (m) return fb;
  }
  // Fallback: first membership
  const [m] = await db.select({ orgId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.userId, caller.userId))
    .limit(1);
  return m?.orgId ?? null;
}

// ── Templates ────────────────────────────────────────────────────────────────
// Both paths supported: canonical and the nested form used by the mobile client.

/** Shape templates for clients with the fields the mobile/web UI expects. */
function publicTemplates() {
  // Photo count is unknown at template-listing time, so report duration
  // assuming the typical 4-photo reel (intro + 4*per-photo + outro).
  return HIGHLIGHT_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    durationSeconds: Math.round(t.introSeconds + 4 * t.perPhotoSeconds + t.outroSeconds),
    primaryColor: t.accent,
    secondaryColor: t.background,
    introSeconds: t.introSeconds,
    perPhotoSeconds: t.perPhotoSeconds,
    outroSeconds: t.outroSeconds,
  }));
}

router.get("/portal/highlight-templates", (_req: Request, res: Response) => {
  res.json({ templates: publicTemplates() });
});
router.get("/portal/highlights/templates", (_req: Request, res: Response) => {
  res.json({ templates: publicTemplates() });
});

/** Build a public URL the mobile/web client can stream from. */
function publicUrlFor(objectPath: string | null): string | null {
  if (!objectPath) return null;
  // outputObjectPath is "/objects/<rest>" — rewrite to the storage server route
  if (!objectPath.startsWith("/objects/")) return null;
  const rest = objectPath.slice("/objects/".length);
  return `/api/storage/objects/${rest}`;
}

/** Decorate a reel row with `outputUrl`, `thumbnailUrl`, and live progress
 * fields (queue position, attempt counts, retry timing) so the mobile/web
 * UI can show players exactly what their render is doing right now.
 *
 * `queuePosition` and `estimatedWaitSeconds` are optional — pass them in
 * for list endpoints (where we compute positions in bulk) or let detail
 * endpoints look them up per-reel via getQueuePosition().
 */
type ReelRow = typeof highlightReelsTable.$inferSelect;
type EngagementCounts = {
  downloadCount: number;
  shareCount: number;
  // Task #708 — feed-surface engagement (in-feed plays + re-shares from the
  // feed). Kept as separate counters so producers can tell a "watched in feed"
  // event apart from an "owner saved/shared from gallery" event.
  viewCount: number;
  feedShareCount: number;
};

const EMPTY_COUNTS = (): EngagementCounts => ({
  downloadCount: 0, shareCount: 0, viewCount: 0, feedShareCount: 0,
});

/** Aggregate engagement counts for the given reel ids. Always returns a
 * map containing zero-value entries for ids that have no events yet so
 * the caller can decorate every reel uniformly. */
async function fetchEngagementCounts(reelIds: number[]): Promise<Map<number, EngagementCounts>> {
  const out = new Map<number, EngagementCounts>();
  for (const id of reelIds) out.set(id, EMPTY_COUNTS());
  if (reelIds.length === 0) return out;
  // Non-view events: raw row counts. Each download/share/feed_share is a
  // distinct user action worth surfacing on its own.
  const rows = await db
    .select({
      reelId: highlightReelEngagementsTable.reelId,
      eventType: highlightReelEngagementsTable.eventType,
      n: sql<number>`count(*)::int`,
    })
    .from(highlightReelEngagementsTable)
    .where(and(
      inArray(highlightReelEngagementsTable.reelId, reelIds),
      sql`${highlightReelEngagementsTable.eventType} <> 'view'`,
    ))
    .groupBy(highlightReelEngagementsTable.reelId, highlightReelEngagementsTable.eventType);
  for (const r of rows) {
    const slot = out.get(Number(r.reelId)) ?? EMPTY_COUNTS();
    if (r.eventType === "download") slot.downloadCount = Number(r.n);
    else if (r.eventType === "share") slot.shareCount = Number(r.n);
    else if (r.eventType === "feed_share") slot.feedShareCount = Number(r.n);
    out.set(Number(r.reelId), slot);
  }
  // Task #864 — collapse repeated 'view' pings from the same viewer on the
  // same reel within a single day to one count. The raw rows in
  // highlight_reel_engagements are kept untouched for future analytics; we
  // simply dedupe in the aggregate query so the surfaced viewCount is a
  // trustworthy "people who watched today" number rather than a play count
  // inflated by replays, scrub-backs, and feed reloads. Anonymous (null
  // user_id) rows fall back to the row id so each anonymous play still
  // counts once — they're not duplicates of each other.
  const viewRows = await db.execute<{ reel_id: number; n: number }>(sql`
    SELECT reel_id, COUNT(*)::int AS n FROM (
      SELECT DISTINCT reel_id,
        COALESCE(user_id::text, 'anon_' || id::text) AS viewer,
        date_trunc('day', created_at) AS day
      FROM highlight_reel_engagements
      WHERE event_type = 'view'
        AND reel_id IN (${sql.join(reelIds.map(id => sql`${id}`), sql`, `)})
    ) sub
    GROUP BY reel_id
  `);
  const viewIter = (viewRows as unknown as { rows?: Array<{ reel_id: number; n: number }> }).rows
    ?? (viewRows as unknown as Array<{ reel_id: number; n: number }>);
  for (const r of viewIter) {
    const slot = out.get(Number(r.reel_id)) ?? EMPTY_COUNTS();
    slot.viewCount = Number(r.n);
    out.set(Number(r.reel_id), slot);
  }
  return out;
}

/** Bulk hour-of-day "best hour" lookup (Task #1011). Returns a map of
 * reelId → best hour (0-23) over the given trailing window, in the
 * caller's local time. Reels with zero engagement are omitted. */
async function fetchBestHours(
  reelIds: number[],
  tzOffsetMinutes: number,
  days = 30,
): Promise<Map<number, { hour: number; count: number }>> {
  const out = new Map<number, { hour: number; count: number }>();
  if (reelIds.length === 0) return out;
  const since = new Date(Date.now() - days * 86_400_000);
  // We compute the per-(reel, hour) totals in an inner subquery, then
  // rank with ROW_NUMBER on the OUTER projection (`n`, `hour`) — never
  // reaching back into `created_at`. The previous shape repeated the
  // EXTRACT(HOUR FROM …) expression inside ROW_NUMBER's ORDER BY, and
  // Postgres' planner couldn't always recognise it as the same grouped
  // expression — that 500'd the entire /portal/highlights list endpoint
  // the moment a reel had even one engagement event. Inlining the
  // (already-clamped) tzOffsetMinutes as a SQL literal also drops the
  // duplicated parameter binding that confused the planner.
  const tz = sql.raw(String(Math.trunc(tzOffsetMinutes)));
  const rows = await db.execute<{ reel_id: number; hour: number; n: number }>(sql`
    SELECT reel_id, hour, n FROM (
      SELECT
        reel_id, hour, n,
        ROW_NUMBER() OVER (PARTITION BY reel_id ORDER BY n DESC, hour DESC) AS rn
      FROM (
        SELECT
          reel_id,
          EXTRACT(HOUR FROM ((created_at AT TIME ZONE 'UTC') + (${tz} * interval '1 minute')))::int AS hour,
          COUNT(*)::int AS n
        FROM highlight_reel_engagements
        WHERE reel_id IN (${sql.join(reelIds.map(id => sql`${id}`), sql`, `)})
          AND created_at >= ${since}
        GROUP BY reel_id, hour
      ) grouped
    ) ranked
    WHERE rn = 1
  `);
  const iter = (rows as unknown as { rows?: Array<{ reel_id: number; hour: number; n: number }> }).rows
    ?? (rows as unknown as Array<{ reel_id: number; hour: number; n: number }>);
  for (const r of iter) {
    out.set(Number(r.reel_id), { hour: Number(r.hour), count: Number(r.n) });
  }
  return out;
}

function decorate(reel: ReelRow, extra?: {
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  engagement?: EngagementCounts;
  bestHour?: number | null;
}) {
  // Retry message: when a reel is queued AND has at least one prior attempt
  // AND its next_attempt_at is in the future, it's waiting for a backoff.
  const now = Date.now();
  const nextAttemptMs = reel.nextAttemptAt ? new Date(reel.nextAttemptAt).getTime() : 0;
  const isRetrying = reel.status === "queued"
    && (reel.attempts ?? 0) > 0
    && nextAttemptMs > now;
  const retryInSeconds = isRetrying ? Math.max(0, Math.round((nextAttemptMs - now) / 1000)) : null;

  return {
    ...reel,
    outputUrl: publicUrlFor(reel.outputObjectPath),
    thumbnailUrl: publicUrlFor(reel.thumbnailPath),
    // Progress fields (Task #551)
    maxAttempts: MAX_ATTEMPTS,
    queuePosition: extra?.queuePosition ?? null,
    estimatedWaitSeconds: extra?.estimatedWaitSeconds ?? null,
    isRetrying,
    retryInSeconds,
    // Task #544 — engagement counts default to 0 so clients can always
    // render the badge without null-checking.
    downloadCount: extra?.engagement?.downloadCount ?? 0,
    shareCount: extra?.engagement?.shareCount ?? 0,
    // Task #708 — feed-surface plays + re-shares.
    viewCount: extra?.engagement?.viewCount ?? 0,
    feedShareCount: extra?.engagement?.feedShareCount ?? 0,
    // Task #1011 — hour-of-day callout. null when there's not enough
    // engagement yet to pick a "best" hour.
    bestHour: extra?.bestHour ?? null,
  };
}

/** True when the caller is an admin/director of the given org. Works for
 * both session-authenticated users (req.user) and portal-token callers
 * (req.portalUser) — we always fall back to checking org_memberships so
 * portal-token admins are recognized too. */
async function isOrgAdmin(req: Request, orgId: number): Promise<boolean> {
  // Fast-paths for session-authenticated users that already carry a role
  // and organizationId on req.user.
  if (req.isAuthenticated()) {
    const u = req.user as { id?: number; role?: string; organizationId?: number };
    if (u?.role === "super_admin") return true;
    if ((u?.role === "org_admin" || u?.role === "tournament_director") && Number(u?.organizationId) === orgId) {
      return true;
    }
  }
  // Fall through to a membership lookup for everyone — covers both
  // session-auth users without a fast-path role and portal-token callers
  // (mobile/portal flows) where authorization lives in org_memberships.
  const caller = getCaller(req);
  if (!caller) return false;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.userId, caller.userId),
      eq(orgMembershipsTable.organizationId, orgId),
    ))
    .limit(1);
  return !!m && (m.role === "org_admin" || m.role === "tournament_director");
}

/** Compute estimated wait based on queue position + average render time. */
function estimateWait(position: number | null): number | null {
  if (position == null) return null;
  // Position 1 means "next to start" — assume one render is already in
  // flight, so wait is roughly position * average. Cap so we don't show
  // alarming numbers for huge queues.
  return Math.min(position * AVG_RENDER_SECONDS, 60 * 60);
}

// ── Clip authorization (shared by POST + PATCH) ──────────────────────────────
//
// `options.clips` may reference media uploaded by other members (e.g. round
// photos), so we MUST verify each mediaId at the API boundary before we
// persist it. Any clip that fails authorization is silently dropped — the
// renderer applies the same filter as defence-in-depth.
//
// A clip qualifies when its media row is approved + same org AND either
//   (a) was uploaded by the caller, OR
//   (b) belongs to the reel's tournament (round photos are shared).
//
// Per-clip trim windows (`startSec` / `durationSec`) are honored only for
// video clips whose source `durationSeconds` is measured (Task #1574).
// Legacy clips (`durationSeconds = NULL`) cannot have a trim window
// applied because we don't know the true source length, and per
// Task #1323 the server must NEVER back-fill a default window in that
// case. Trim values on non-video media are also dropped — they are
// meaningless for stills.
type AuthorizedClip = {
  mediaId: number;
  caption?: string;
  startSec?: number;
  durationSec?: number;
};

type AuthorizedClipsResult = {
  clips: AuthorizedClip[];
  // Task #1961 — mediaIds whose user-supplied trim window had to be
  // shortened to fit the source video. The POST/PATCH handlers surface
  // this list so the editor can show a "Trimmed to fit the source video"
  // notice next to the affected clip. We only flag the source-video clamp
  // (start + duration ran past the end of the source); pure sanity bounds
  // (e.g. clamping a 200s window to the 60s editor cap) do not trigger
  // the notice — those aren't about the source video at all.
  trimClampedMediaIds: number[];
};

async function authorizeClips(
  clipsInput: unknown,
  ctx: { orgId: number; userId: number; tournamentId: number | null },
): Promise<AuthorizedClipsResult | null> {
  if (!Array.isArray(clipsInput)) return null;
  const requested = clipsInput
    .filter((c): c is { mediaId: number | string; caption?: unknown; startSec?: unknown; durationSec?: unknown } =>
      !!c && typeof c === "object" && Number.isFinite(Number((c as { mediaId?: unknown }).mediaId)))
    .slice(0, 12)
    .map(c => ({
      mediaId: Number(c.mediaId),
      caption: typeof c.caption === "string" && c.caption.trim()
        ? c.caption.trim().slice(0, 140)
        : undefined,
      startSecRaw: c.startSec,
      durationSecRaw: c.durationSec,
    }));
  if (requested.length === 0) return { clips: [], trimClampedMediaIds: [] };
  const ids = requested.map(c => c.mediaId);
  const rows = await db.select().from(mediaTable).where(and(
    eq(mediaTable.organizationId, ctx.orgId),
    eq(mediaTable.approved, true),
    inArray(mediaTable.id, ids),
  ));
  const byId = new Map(rows.map(r => [r.id, r]));
  const authorized: AuthorizedClip[] = [];
  const trimClampedMediaIds: number[] = [];
  for (const c of requested) {
    const m = byId.get(c.mediaId);
    if (!m) continue;
    const ownsByUpload = m.uploadedByUserId === ctx.userId;
    const ownsByRound = !!(ctx.tournamentId && m.tournamentId === ctx.tournamentId);
    if (!ownsByUpload && !ownsByRound) continue;
    const out: AuthorizedClip = { mediaId: c.mediaId };
    if (c.caption) out.caption = c.caption;
    if (m.mediaType === "video" && m.durationSeconds != null) {
      const sourceDur = m.durationSeconds;
      const userAskedForWindow =
        (typeof c.startSecRaw === "number" && Number.isFinite(c.startSecRaw))
        || (typeof c.durationSecRaw === "number" && Number.isFinite(c.durationSecRaw));
      let startNum = typeof c.startSecRaw === "number" && Number.isFinite(c.startSecRaw)
        ? Math.max(0, c.startSecRaw as number)
        : undefined;
      let durNum = typeof c.durationSecRaw === "number" && Number.isFinite(c.durationSecRaw)
        ? Math.min(60, Math.max(0.5, c.durationSecRaw as number))
        : undefined;
      // Snapshot the user's bounds-normalised request so we can detect a
      // source-video clamp below. Sanity bounds (0.5s floor / 60s ceiling
      // / negative-start floor) are NOT considered "trimmed to fit the
      // source video" — those are editor limits, not source limits.
      const requestedDur = durNum;
      let sourceClamped = false;
      // If the requested start is at/past the source duration, the trim
      // is unusable — drop both fields rather than persist an empty
      // window the renderer would have to guess at.
      if (startNum != null && startNum >= sourceDur) {
        startNum = undefined;
        durNum = undefined;
        if (userAskedForWindow) sourceClamped = true;
      }
      // Clamp duration so start+duration never exceeds the source.
      if (durNum != null) {
        const effStart = startNum ?? 0;
        const maxDur = sourceDur - effStart;
        if (maxDur < 0.5) {
          durNum = undefined;
          sourceClamped = true;
        } else if (durNum > maxDur) {
          durNum = maxDur;
          sourceClamped = true;
        }
      }
      if (startNum != null) out.startSec = startNum;
      if (durNum != null) out.durationSec = durNum;
      // Only surface the notice if the user's pick was actually
      // shortened from a real, finite request. A clip with no requested
      // window can't be "shortened" — it just inherits the renderer's
      // default. `requestedDur` proves the user typed in a duration.
      if (sourceClamped && requestedDur != null) {
        trimClampedMediaIds.push(c.mediaId);
      }
    }
    authorized.push(out);
  }
  return { clips: authorized, trimClampedMediaIds };
}

// ── Candidate media for the editor ───────────────────────────────────────────
// Returns the player's own approved photos and videos that can be hand-picked
// into a highlight reel. Optionally scoped to a tournament. Used by the mobile
// editor to show thumbnails and let the player include/exclude/reorder clips.

router.get("/portal/highlights/candidate-media", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = await resolveOrgIdForCaller(req, caller, req.query.organizationId as string | undefined);
  if (!orgId) { { res.status(400).json({ error: "No organization context" }); return; } }
  const tIdRaw = req.query.tournamentId;
  const tId = tIdRaw ? Number(tIdRaw) : null;

  // Candidate media for the editor:
  //   • when a round (tournamentId) is selected → media uploaded TO that round
  //     (regardless of uploader, since round media is shared) PLUS the
  //     caller's own uploads in that round/tournament context.
  //   • without a round → caller's own approved uploads.
  // We additionally enforce same-org and approved=true. The caller is
  // verified to be a member of the org via resolveOrgIdForCaller above.
  // For the per-tournament case we also confirm the tournament belongs to
  // the caller's org so a guessed ID can't surface another club's media.
  let validTournamentId: number | null = null;
  if (tId && Number.isFinite(tId)) {
    const [t] = await db.select({ id: tournamentsTable.id, orgId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, tId)).limit(1);
    if (t && t.orgId === orgId) validTournamentId = tId;
  }

  const accessFilter = validTournamentId
    ? or(
        eq(mediaTable.tournamentId, validTournamentId),
        eq(mediaTable.uploadedByUserId, caller.userId),
      )!
    : eq(mediaTable.uploadedByUserId, caller.userId);

  const rows = await db.select().from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      eq(mediaTable.approved, true),
      accessFilter,
    ))
    .orderBy(desc(mediaTable.createdAt))
    .limit(60);

  const filteredRows = rows.filter(m => m.mediaType === "image" || m.mediaType === "video");

  // ── Auto-caption suggestions (Task #541) ──────────────────────────────
  // For each media item with a holeNumber, generate up to 3 short caption
  // chips from the player's shot data on that hole (club, carry distance,
  // par, score-to-par). The mobile editor renders these as tap-to-fill
  // chips so players don't have to type on a phone keyboard.
  const holeNumbers = Array.from(new Set(
    filteredRows.map(m => m.holeNumber).filter((h): h is number => h != null),
  ));
  const tournamentIdSet = Array.from(new Set(
    filteredRows.map(m => m.tournamentId).filter((t): t is number => t != null),
  ));
  const courseIdSet = new Set<number>();
  filteredRows.forEach(m => { if (m.courseId) courseIdSet.add(m.courseId); });

  const tournamentCourseMap = new Map<number, number | null>();
  const tournamentPlayerMap = new Map<number, number>();
  if (tournamentIdSet.length > 0) {
    const tRows = await db.select({
      id: tournamentsTable.id,
      courseId: tournamentsTable.courseId,
    }).from(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIdSet));
    tRows.forEach(t => {
      tournamentCourseMap.set(t.id, t.courseId ?? null);
      if (t.courseId) courseIdSet.add(t.courseId);
    });

    const [callerUser] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, caller.userId)).limit(1);
    const callerEmail = (callerUser?.email ?? "").toLowerCase();
    const playerRows = await db.select({
      id: playersTable.id,
      tournamentId: playersTable.tournamentId,
      userId: playersTable.userId,
      email: playersTable.email,
    }).from(playersTable).where(inArray(playersTable.tournamentId, tournamentIdSet));
    for (const p of playerRows) {
      const owns = (p.userId != null && p.userId === caller.userId)
        || (callerEmail && p.email && p.email.toLowerCase() === callerEmail);
      if (owns) tournamentPlayerMap.set(p.tournamentId, p.id);
    }
  }

  const tournamentShots = (tournamentPlayerMap.size > 0 && holeNumbers.length > 0)
    ? await db.select().from(shotsTable).where(and(
        inArray(shotsTable.playerId, Array.from(tournamentPlayerMap.values())),
        inArray(shotsTable.holeNumber, holeNumbers),
      ))
    : [];
  // Order general-play shots most-recent-first so the fallback picks the
  // player's latest round on a given hole rather than an arbitrary one.
  const generalShots = holeNumbers.length > 0
    ? await db.select().from(shotsTable).where(and(
        eq(shotsTable.userId, caller.userId),
        inArray(shotsTable.holeNumber, holeNumbers),
      )).orderBy(desc(shotsTable.recordedAt))
    : [];

  const parMap = new Map<string, number>(); // `${courseId}_${hole}` → par
  if (courseIdSet.size > 0 && holeNumbers.length > 0) {
    const holeRows = await db.select({
      courseId: holeDetailsTable.courseId,
      holeNumber: holeDetailsTable.holeNumber,
      par: holeDetailsTable.par,
    }).from(holeDetailsTable).where(and(
      inArray(holeDetailsTable.courseId, Array.from(courseIdSet)),
      inArray(holeDetailsTable.holeNumber, holeNumbers),
    ));
    holeRows.forEach(h => parMap.set(`${h.courseId}_${h.holeNumber}`, h.par));
  }

  // Load the player's saved caption-style templates (Task #698) so that
  // suggestions for new shots can be rendered through their preferred
  // wording. Cheap one-shot fetch — typical players will have <10.
  const savedTemplates = await db.select().from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.userId, caller.userId))
    .orderBy(desc(highlightCaptionTemplatesTable.lastUsedAt), desc(highlightCaptionTemplatesTable.createdAt));

  const buildTokens = (m: typeof filteredRows[number]): Record<string, string | number> | null => {
    if (m.holeNumber == null) return null;
    const hole = m.holeNumber;
    let shots: typeof tournamentShots = [];
    if (m.tournamentId && tournamentPlayerMap.has(m.tournamentId)) {
      const pid = tournamentPlayerMap.get(m.tournamentId)!;
      shots = tournamentShots.filter(s => s.playerId === pid && s.holeNumber === hole);
    }
    if (shots.length === 0 && m.uploadedByUserId === caller.userId) {
      const recent = generalShots.filter(s => s.holeNumber === hole);
      if (recent.length > 0) {
        const rid = recent[0].generalPlayRoundId;
        shots = rid != null
          ? recent.filter(s => s.generalPlayRoundId === rid)
          : [recent[0]];
      }
    }
    const teeShot = shots.find(s => s.shotNumber === 1) ?? shots[0] ?? null;
    const courseId = (m.tournamentId && tournamentCourseMap.get(m.tournamentId)) || m.courseId || null;
    const par = courseId ? parMap.get(`${courseId}_${hole}`) ?? null : null;
    const carry = teeShot?.distanceCarried ? Math.round(Number(teeShot.distanceCarried)) : null;

    const tokens: Record<string, string | number> = { hole };
    if (teeShot?.club) tokens.club = teeShot.club;
    if (carry != null) tokens.carry = carry;
    if (par != null) {
      tokens.par = par;
      if (shots.length > 0) {
        const diff = shots.length - par;
        tokens.scoreLabel = diff <= -2 ? "Eagle"
          : diff === -1 ? "Birdie"
          : diff === 0 ? "Par"
          : diff === 1 ? "Bogey"
          : diff === 2 ? "Double Bogey"
          : `+${diff}`;
      }
    }
    return tokens;
  };

  // Render `pattern` against `tokens`, returning null if any required
  // token key is missing (so we don't surface "Hole 7 · {club} · 165y").
  const applyPattern = (pattern: string, tokenKeys: string[], tokens: Record<string, string | number>): string | null => {
    for (const k of tokenKeys) if (!(k in tokens)) return null;
    return pattern.replace(/\{(\w+)\}/g, (_, k) => String(tokens[k] ?? `{${k}}`));
  };

  // Default suggestion shapes — same wording the editor has shown since
  // Task #541, but now expressed as (pattern, tokenKeys) so we can save
  // them as templates and re-render them for similar shots.
  type SuggestionShape = { pattern: string; tokenKeys: string[]; requires: string[] };
  const SUGGESTION_SHAPES: SuggestionShape[] = [
    { pattern: "Hole {hole} · {club} · {carry}y", tokenKeys: ["hole", "club", "carry"], requires: ["hole", "club", "carry"] },
    { pattern: "Hole {hole} · {club}",            tokenKeys: ["hole", "club"],          requires: ["hole", "club"] },
    { pattern: "Hole {hole} · {carry}y",          tokenKeys: ["hole", "carry"],         requires: ["hole", "carry"] },
    { pattern: "Hole {hole} · Par {par} · {scoreLabel}", tokenKeys: ["hole", "par", "scoreLabel"], requires: ["hole", "par", "scoreLabel"] },
    { pattern: "Hole {hole} · Par {par}",         tokenKeys: ["hole", "par"],           requires: ["hole", "par"] },
    { pattern: "Hole {hole}",                     tokenKeys: ["hole"],                  requires: ["hole"] },
  ];

  type Suggestion = {
    text: string;
    pattern: string;
    tokenKeys: string[];
    tokens: Record<string, string | number>;
    isFavorite: boolean;
    templateId: number | null;
  };

  const buildSuggestions = (m: typeof filteredRows[number]): Suggestion[] => {
    const tokens = buildTokens(m);
    if (!tokens) return [];

    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const push = (text: string, pattern: string, tokenKeys: string[], templateId: number | null) => {
      if (seen.has(text)) return;
      seen.add(text);
      out.push({ text, pattern, tokenKeys, tokens, isFavorite: templateId != null, templateId });
    };

    // 1. User's saved templates first — their preferred wording wins.
    for (const tpl of savedTemplates) {
      const text = applyPattern(tpl.pattern, tpl.tokenKeys ?? [], tokens);
      if (text) push(text, tpl.pattern, tpl.tokenKeys ?? [], tpl.id);
    }

    // 2. Fallback to the built-in shapes so brand-new players still get
    //    helpful suggestions. We keep building the standard "club + carry"
    //    chip even when the user has a template — variety is good.
    for (const shape of SUGGESTION_SHAPES) {
      if (out.length >= 3) break;
      if (shape.requires.some(k => !(k in tokens))) continue;
      const text = applyPattern(shape.pattern, shape.tokenKeys, tokens)!;
      const matchedTpl = savedTemplates.find(t => t.pattern === shape.pattern) ?? null;
      push(text, shape.pattern, shape.tokenKeys, matchedTpl?.id ?? null);
    }

    return out.slice(0, 3);
  };

  const items = filteredRows.map(m => {
    const suggestions = buildSuggestions(m);
    return {
      id: m.id,
      mediaType: m.mediaType,
      caption: m.caption,
      holeNumber: m.holeNumber,
      tournamentId: m.tournamentId,
      uploadedByMe: m.uploadedByUserId === caller.userId,
      createdAt: m.createdAt,
      url: publicUrlFor(m.objectPath),
      thumbnailUrl: publicUrlFor(m.thumbnailPath) ?? (m.mediaType === "image" ? publicUrlFor(m.objectPath) : null),
      // Task #703 — true source duration (in seconds) so the editor can
      // disable the start/length steppers once they would push past the
      // video's end. NULL for images and for legacy video rows uploaded
      // before the duration column existed.
      durationSeconds: m.mediaType === "video" ? m.durationSeconds ?? null : null,
      // Backward-compat plain strings for older clients.
      suggestedCaptions: suggestions.map(s => s.text),
      // Task #698 — rich form lets the mobile editor render a star icon
      // and POST/DELETE favorites without re-deriving the pattern.
      suggestedCaptionTemplates: suggestions,
    };
  });
  res.json({ media: items });
});

// ── Caption style templates (Task #698) ──────────────────────────────────────
// Players favorite a caption chip → we persist its pattern + token keys so
// future suggestions for similar shots are rendered through the saved style.

router.get("/portal/highlights/caption-templates", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const rows = await db.select().from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.userId, caller.userId))
    .orderBy(desc(highlightCaptionTemplatesTable.lastUsedAt), desc(highlightCaptionTemplatesTable.createdAt))
    .limit(50);
  res.json({ templates: rows });
});

router.post("/portal/highlights/caption-templates", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const body = req.body ?? {};
  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  const sampleCaption = typeof body.sampleCaption === "string" && body.sampleCaption.trim()
    ? body.sampleCaption.trim().slice(0, 280)
    : pattern;
  const tokenKeysRaw = Array.isArray(body.tokenKeys) ? body.tokenKeys : [];
  const tokenKeys = tokenKeysRaw
    .filter((k: unknown): k is string => typeof k === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k))
    .slice(0, 12);

  if (!pattern || pattern.length > 280) {
    res.status(400).json({ error: "pattern is required (max 280 chars)" }); return;
  }
  // Sanity-check that every {token} placeholder in the pattern has a key.
  const referenced = Array.from(pattern.matchAll(/\{(\w+)\}/g)).map((m: RegExpMatchArray) => m[1]);
  for (const ref of referenced) {
    if (!tokenKeys.includes(ref)) {
      res.status(400).json({ error: `tokenKeys missing referenced token: ${ref}` }); return;
    }
  }

  const orgId = await resolveOrgIdForCaller(req, caller, body.organizationId);
  // Cap per-user to keep the favorites list manageable on a phone screen.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.userId, caller.userId));
  if (Number(n ?? 0) >= 20) {
    // Allow upserting an existing pattern, just not creating new ones.
    const [existing] = await db.select().from(highlightCaptionTemplatesTable)
      .where(and(
        eq(highlightCaptionTemplatesTable.userId, caller.userId),
        eq(highlightCaptionTemplatesTable.pattern, pattern),
      )).limit(1);
    if (!existing) {
      res.status(400).json({ error: "You can save up to 20 caption styles. Remove one first." });
      return;
    }
  }

  // Upsert on (userId, pattern) so re-favoriting the same chip is a no-op.
  const [row] = await db.insert(highlightCaptionTemplatesTable).values({
    userId: caller.userId,
    organizationId: orgId,
    pattern,
    tokenKeys,
    sampleCaption,
    lastUsedAt: new Date(),
  }).onConflictDoUpdate({
    target: [highlightCaptionTemplatesTable.userId, highlightCaptionTemplatesTable.pattern],
    set: {
      tokenKeys,
      sampleCaption,
      updatedAt: new Date(),
      lastUsedAt: new Date(),
    },
  }).returning();

  res.status(201).json({ template: row });
});

// Task #856 — Edit a saved caption template's pattern. We rederive
// `tokenKeys` from the placeholders in the new pattern so they can never
// drift out of sync with the wording. The sample caption is left as-is
// (it's just a preview snapshot) unless the caller passes a fresh one.
router.patch("/portal/highlights/caption-templates/:id", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [tpl] = await db.select().from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.id, id)).limit(1);
  if (!tpl || tpl.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }

  const body = req.body ?? {};
  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  if (!pattern || pattern.length > 280) {
    res.status(400).json({ error: "pattern is required (max 280 chars)" }); return;
  }

  // Recompute token keys from the placeholders in the new pattern. Validate
  // each looks like a sane identifier so a typo doesn't surface garbage to
  // the auto-suggestion code path.
  const referenced = Array.from(new Set(
    Array.from(pattern.matchAll(/\{(\w+)\}/g)).map((m: RegExpMatchArray) => m[1]),
  ));
  for (const k of referenced) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) {
      res.status(400).json({ error: `Invalid token: ${k}` }); return;
    }
  }
  if (referenced.length > 12) {
    res.status(400).json({ error: "Too many tokens (max 12)" }); return;
  }

  // Forbid colliding with another template the same user already saved.
  if (pattern !== tpl.pattern) {
    const [conflict] = await db.select({ id: highlightCaptionTemplatesTable.id })
      .from(highlightCaptionTemplatesTable)
      .where(and(
        eq(highlightCaptionTemplatesTable.userId, caller.userId),
        eq(highlightCaptionTemplatesTable.pattern, pattern),
      )).limit(1);
    if (conflict) {
      res.status(409).json({ error: "You already saved that exact caption style" }); return;
    }
  }

  const newSample = typeof body.sampleCaption === "string" && body.sampleCaption.trim()
    ? body.sampleCaption.trim().slice(0, 280)
    : tpl.sampleCaption;

  const [row] = await db.update(highlightCaptionTemplatesTable).set({
    pattern,
    tokenKeys: referenced,
    sampleCaption: newSample,
    updatedAt: new Date(),
  }).where(eq(highlightCaptionTemplatesTable.id, id)).returning();

  res.json({ template: row });
});

// Task #856 — Bump the use counter when a player applies a saved chip
// in the editor. Best-effort analytics: callers ignore failures, and we
// only return 204 to keep the chip-tap path snappy. The caller may
// optionally pass `sampleCaption` so the management screen always shows
// the most recent rendered text rather than the wording snapshotted at
// the moment the player first favorited the chip.
router.post("/portal/highlights/caption-templates/:id/use", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [tpl] = await db.select({ id: highlightCaptionTemplatesTable.id, userId: highlightCaptionTemplatesTable.userId })
    .from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.id, id)).limit(1);
  if (!tpl || tpl.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  const body = req.body ?? {};
  const sampleCaption = typeof body.sampleCaption === "string" && body.sampleCaption.trim()
    ? body.sampleCaption.trim().slice(0, 280)
    : null;
  await db.update(highlightCaptionTemplatesTable).set({
    useCount: sql`${highlightCaptionTemplatesTable.useCount} + 1`,
    lastUsedAt: new Date(),
    updatedAt: new Date(),
    ...(sampleCaption ? { sampleCaption } : {}),
  }).where(eq(highlightCaptionTemplatesTable.id, id));
  res.status(204).end();
});

router.delete("/portal/highlights/caption-templates/:id", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [tpl] = await db.select().from(highlightCaptionTemplatesTable)
    .where(eq(highlightCaptionTemplatesTable.id, id)).limit(1);
  if (!tpl || tpl.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  await db.delete(highlightCaptionTemplatesTable).where(eq(highlightCaptionTemplatesTable.id, id));
  res.json({ ok: true });
});

// ── List my reels ────────────────────────────────────────────────────────────

router.get("/portal/highlights", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = await resolveOrgIdForCaller(req, caller, req.query.organizationId as string | undefined);
  if (!orgId) { { res.status(400).json({ error: "No organization context" }); return; } }

  // Task #1012 — `sort` query param lets producers rank their reels by
  // total engagement or re-share count instead of recency. We always pull
  // the full per-user list (capped at 50) and then reorder by the
  // engagement counts that we're already computing below, so the sort
  // operates over the same numbers shown on each card.
  const sortRaw = String(req.query.sort ?? "recent").toLowerCase();
  const sort: "recent" | "top" | "reshared" =
    sortRaw === "top" || sortRaw === "engagement" ? "top"
    : sortRaw === "reshared" || sortRaw === "feed_share" ? "reshared"
    : "recent";

  const rows = await db.select().from(highlightReelsTable)
    .where(and(eq(highlightReelsTable.userId, caller.userId), eq(highlightReelsTable.organizationId, orgId)))
    .orderBy(desc(highlightReelsTable.createdAt))
    .limit(50);

  // Compute queue positions in one shot for any rows still waiting.
  // For a small per-user list this is cheap and avoids N round-trips.
  const positions = new Map<number, number>();
  const waitingIds = rows.filter(r => r.status === "queued").map(r => r.id);
  if (waitingIds.length > 0) {
    const posRows = await db.execute<{ id: number; pos: number }>(sql`
      WITH queued AS (
        SELECT id, next_attempt_at,
               row_number() OVER (ORDER BY next_attempt_at ASC, id ASC) AS pos
        FROM highlight_reels
        WHERE status = 'queued' AND next_attempt_at <= now()
      )
      SELECT id::int AS id, pos::int AS pos
      FROM queued
      WHERE id = ANY(ARRAY[${sql.join(waitingIds.map(id => sql`${id}`), sql`, `)}]::int[])
    `);
    for (const p of posRows.rows) positions.set(Number(p.id), Number(p.pos));
  }

  const quota = await quotaForOrg(orgId);
  const used = await rendersThisMonth(caller.userId, orgId);
  const queueDepth = waitingIds.length > 0 ? await getQueueDepth() : 0;
  const counts = await fetchEngagementCounts(rows.map(r => r.id));
  // Task #1011 — surface the best-engagement hour per reel so the
  // gallery can render a "Best hour: 7pm" badge without a per-row fetch.
  // Honors the caller's local timezone via ?tzOffsetMinutes=X (signed).
  const tzRaw = Number(req.query.tzOffsetMinutes);
  const tzOffsetMinutes = Number.isFinite(tzRaw)
    ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(tzRaw)))
    : 0;
  const bestHours = await fetchBestHours(rows.map(r => r.id), tzOffsetMinutes);

  // Apply the chosen sort. "top" = sum of all four engagement events,
  // "reshared" = re-shares from the feed, "recent" leaves the
  // chronological order from the SQL query untouched. Ties fall back to
  // createdAt-desc so the order is stable for QA/tests.
  const totalFor = (id: number) => {
    const c = counts.get(id);
    if (!c) return 0;
    return c.viewCount + c.feedShareCount + c.shareCount + c.downloadCount;
  };
  const reshareFor = (id: number) => counts.get(id)?.feedShareCount ?? 0;
  const tieBreak = (a: typeof rows[number], b: typeof rows[number]) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  const sortedRows = sort === "recent"
    ? rows
    : rows.slice().sort((a, b) => {
        const av = sort === "top" ? totalFor(a.id) : reshareFor(a.id);
        const bv = sort === "top" ? totalFor(b.id) : reshareFor(b.id);
        return bv - av || tieBreak(a, b);
      });

  res.json({
    reels: sortedRows.map(r => {
      const pos = positions.get(r.id) ?? null;
      return decorate(r, {
        queuePosition: pos,
        estimatedWaitSeconds: estimateWait(pos),
        engagement: counts.get(r.id),
        bestHour: bestHours.get(r.id)?.hour ?? null,
      });
    }),
    quota: { monthlyLimit: quota, usedThisMonth: used, remaining: Math.max(0, quota - used) },
    queueDepth,
    sort,
  });
});

// ── Get one ──────────────────────────────────────────────────────────────────

router.get("/portal/highlights/:id", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [reel] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel || reel.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  // Live progress: only worth the queue scan when we're still waiting.
  const pos = reel.status === "queued" ? await getQueuePosition(reel.id) : null;
  const counts = await fetchEngagementCounts([reel.id]);
  res.json(decorate(reel, {
    queuePosition: pos,
    estimatedWaitSeconds: estimateWait(pos),
    engagement: counts.get(reel.id),
  }));
});

// ── Engagement events (Task #544) ────────────────────────────────────────────
// Mobile/web fires a lightweight ping when a member downloads a reel to their
// gallery or hands it off to a share sheet. The server records the event
// (reel id, user id, type) and surfaces aggregate counts on list endpoints
// and the org admin engagement view. Owners can log events on their own
// reels; any org member can log events on a reel that has been posted to
// the social feed (so re-shares from the feed surface get tallied too).

router.post("/portal/highlights/:id/events", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid reel id" }); return; } }

  const rawType = String(req.body?.type ?? req.body?.eventType ?? "").toLowerCase();
  // Task #544 / Task #708 — supported engagement event types:
  //   download    — owner saved the reel from the highlights gallery
  //   share       — owner handed the reel off to a system share sheet
  //   view        — reel was watched past a threshold inside the social feed
  //   feed_share  — viewer re-shared the reel from the feed surface
  const ALLOWED_TYPES = ["download", "share", "view", "feed_share"] as const;
  if (!(ALLOWED_TYPES as readonly string[]).includes(rawType)) {
    res.status(400).json({ error: `type must be one of ${ALLOWED_TYPES.join(", ")}` }); return;
  }
  const rawSource = req.body?.source;
  const source = typeof rawSource === "string" && rawSource.length <= 32
    ? rawSource
    : null;

  const [reel] = await db.select().from(highlightReelsTable)
    .where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel) { { res.status(404).json({ error: "Not found" }); return; } }

  // Authorization: the reel owner can always log events. Once a reel has
  // been posted to the feed, any member of the same org can log events
  // (e.g. a teammate sharing the clip from the feed).
  const isOwner = reel.userId === caller.userId;
  let allowed = isOwner;
  if (!allowed && reel.feedPostId) {
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, caller.userId),
        eq(orgMembershipsTable.organizationId, reel.organizationId),
      )).limit(1);
    if (m) allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Not authorized to log events on this reel" }); return; } }

  await db.insert(highlightReelEngagementsTable).values({
    reelId: reel.id,
    organizationId: reel.organizationId,
    userId: caller.userId,
    eventType: rawType as never,
    source,
  });

  // Task #2020 — best-effort: only the "view" event is meaningful as
  // an email-CTA conversion (downloads / shares are owner actions on
  // their own clip, not the conversion the email was driving). Fire-
  // and-forget; never blocks the 201 response.
  if (rawType === "view") {
    void recordEmailConversionForRequest(req, "highlight_viewed", {
      userId: caller.userId,
    });
  }

  const counts = await fetchEngagementCounts([reel.id]);
  res.status(201).json({ ok: true, ...counts.get(reel.id) });
});

// Per-reel breakdown for the reel owner OR an org admin — lightweight
// stats (totals + recent events) used by the admin engagement view.
router.get("/portal/highlights/:id/engagement", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid reel id" }); return; } }

  const [reel] = await db.select().from(highlightReelsTable)
    .where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel) { { res.status(404).json({ error: "Not found" }); return; } }

  const isOwner = reel.userId === caller.userId;
  const isAdmin = isOwner ? false : await isOrgAdmin(req, reel.organizationId);
  if (!isOwner && !isAdmin) { { res.status(403).json({ error: "Not authorized" }); return; } }

  const counts = await fetchEngagementCounts([reel.id]);
  const recent = await db.select({
    id: highlightReelEngagementsTable.id,
    eventType: highlightReelEngagementsTable.eventType,
    userId: highlightReelEngagementsTable.userId,
    source: highlightReelEngagementsTable.source,
    createdAt: highlightReelEngagementsTable.createdAt,
  }).from(highlightReelEngagementsTable)
    .where(eq(highlightReelEngagementsTable.reelId, reel.id))
    .orderBy(desc(highlightReelEngagementsTable.createdAt))
    .limit(50);

  res.json({
    reelId: reel.id,
    ...counts.get(reel.id),
    recent,
  });
});

// Per-reel engagement timeseries (Task #863) — daily buckets of each
// event type over the last `days` days (default 7, max 90). Powers the
// inline trend chart in the producer-facing highlights gallery so the
// owner can see when a reel actually gets traction vs. a slow-burn.
//
// Auth: reel owner OR an org admin/director of the reel's org.
router.get("/portal/highlights/:id/engagement-timeseries", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid reel id" }); return; } }
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0
    ? Math.min(90, Math.max(1, Math.round(daysRaw)))
    : 7;

  const [reel] = await db.select().from(highlightReelsTable)
    .where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel) { { res.status(404).json({ error: "Not found" }); return; } }
  const isOwner = reel.userId === caller.userId;
  const isAdmin = isOwner ? false : await isOrgAdmin(req, reel.organizationId);
  if (!isOwner && !isAdmin) { { res.status(403).json({ error: "Not authorized" }); return; } }

  const since = new Date(Date.now() - days * 86_400_000);
  const bucketExpr = sql<string>`to_char((${highlightReelEngagementsTable.createdAt} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`;
  const rows = await db.select({
    bucket: bucketExpr,
    eventType: highlightReelEngagementsTable.eventType,
    n: sql<number>`count(*)::int`,
  }).from(highlightReelEngagementsTable)
    .where(and(
      eq(highlightReelEngagementsTable.reelId, id),
      gte(highlightReelEngagementsTable.createdAt, since),
    ))
    .groupBy(bucketExpr, highlightReelEngagementsTable.eventType);

  // Pre-seed every day in the window with zero buckets so the client can
  // render a stable-width chart even when there are no events yet.
  type Slot = { date: string; download: number; share: number; view: number; feed_share: number };
  const buckets = new Map<string, Slot>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, download: 0, share: 0, view: 0, feed_share: 0 });
  }
  for (const r of rows) {
    const slot = buckets.get(String(r.bucket));
    if (!slot) continue;
    if (r.eventType === "download") slot.download = Number(r.n);
    else if (r.eventType === "share") slot.share = Number(r.n);
    else if (r.eventType === "view") slot.view = Number(r.n);
    else if (r.eventType === "feed_share") slot.feed_share = Number(r.n);
  }

  res.json({ reelId: id, days, series: Array.from(buckets.values()) });
});

// Per-reel hour-of-day engagement (Task #1011) — bucket every event by
// the hour it happened in the producer's local time so they can see when
// their audience is actually active. Returns 24 buckets (hour 0-23) plus
// a `bestHour` callout the UI can render as a "Best hour: 7pm" badge.
//
// Query: ?days=N (1-90, default 30) &tzOffsetMinutes=X (signed, default 0)
//   tzOffsetMinutes follows the JS convention `-new Date().getTimezoneOffset()`
//   so callers in PDT (UTC-7) pass -420.
//
// Auth: reel owner OR an org admin/director of the reel's org.
router.get("/portal/highlights/:id/engagement-hourly", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid reel id" }); return; } }
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0
    ? Math.min(90, Math.max(1, Math.round(daysRaw)))
    : 30;
  const tzRaw = Number(req.query.tzOffsetMinutes);
  // Clamp to a sane range (-14h..+14h) so a malformed value can't force
  // postgres to add absurd intervals.
  const tzOffsetMinutes = Number.isFinite(tzRaw)
    ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(tzRaw)))
    : 0;

  const [reel] = await db.select().from(highlightReelsTable)
    .where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel) { { res.status(404).json({ error: "Not found" }); return; } }
  const isOwner = reel.userId === caller.userId;
  const isAdmin = isOwner ? false : await isOrgAdmin(req, reel.organizationId);
  if (!isOwner && !isAdmin) { { res.status(403).json({ error: "Not authorized" }); return; } }

  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.execute<{ hour: number; event_type: string; n: number }>(sql`
    SELECT
      EXTRACT(HOUR FROM ((created_at AT TIME ZONE 'UTC') + (${tzOffsetMinutes} * interval '1 minute')))::int AS hour,
      event_type,
      COUNT(*)::int AS n
    FROM highlight_reel_engagements
    WHERE reel_id = ${id} AND created_at >= ${since}
    GROUP BY hour, event_type
  `);
  const iter = (rows as unknown as { rows?: Array<{ hour: number; event_type: string; n: number }> }).rows
    ?? (rows as unknown as Array<{ hour: number; event_type: string; n: number }>);

  type HourSlot = { hour: number; download: number; share: number; view: number; feed_share: number; total: number };
  const hourly: HourSlot[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h, download: 0, share: 0, view: 0, feed_share: 0, total: 0,
  }));
  for (const r of iter) {
    const slot = hourly[Number(r.hour)];
    if (!slot) continue;
    const n = Number(r.n);
    if (r.event_type === "download") slot.download = n;
    else if (r.event_type === "share") slot.share = n;
    else if (r.event_type === "view") slot.view = n;
    else if (r.event_type === "feed_share") slot.feed_share = n;
    slot.total += n;
  }

  // "Best hour" = the hour with the most total engagement. We tie-break
  // toward the later hour so "evening peak" wins over the lone overnight
  // event when both have the same count, which matches what producers
  // typically care about when scheduling posts.
  let bestHour: number | null = null;
  let bestCount = 0;
  for (const slot of hourly) {
    if (slot.total >= bestCount && slot.total > 0) {
      bestHour = slot.hour;
      bestCount = slot.total;
    }
  }

  res.json({
    reelId: id,
    days,
    tzOffsetMinutes,
    hourly,
    bestHour,
    bestHourCount: bestCount,
  });
});

// Org-wide list for club admins — every reel in the org with engagement
// counts attached, so producers can see at a glance which reels are
// taking off. Newest reels first; capped at 200 to keep payloads small.
router.get("/portal/highlights/admin/list", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = await resolveOrgIdForCaller(req, caller, req.query.organizationId as string | undefined);
  if (!orgId) { { res.status(400).json({ error: "No organization context" }); return; } }
  if (!await isOrgAdmin(req, orgId)) {
    res.status(403).json({ error: "Organization admin access required" }); return;
  }

  // Optional filters — let admins narrow by tournament or date range so they
  // can ask "how is the Spring Open performing?" or "engagement over the last
  // 7 days". Invalid values are silently ignored rather than 400ing so a bad
  // bookmark never breaks the page.
  const tIdRaw = req.query.tournamentId;
  const tIdNum = typeof tIdRaw === "string" && tIdRaw.trim() !== "" ? Number(tIdRaw) : NaN;
  const sinceRaw = typeof req.query.since === "string" ? req.query.since : "";
  const untilRaw = typeof req.query.until === "string" ? req.query.until : "";
  const sinceDate = sinceRaw ? new Date(sinceRaw) : null;
  const untilDate = untilRaw ? new Date(untilRaw) : null;
  const sinceValid = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : null;
  const untilValid = untilDate && !isNaN(untilDate.getTime()) ? untilDate : null;

  const filters = [eq(highlightReelsTable.organizationId, orgId)];
  if (Number.isFinite(tIdNum)) {
    // Verify the tournament belongs to this org before trusting the filter.
    const [t] = await db.select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tIdNum), eq(tournamentsTable.organizationId, orgId)))
      .limit(1);
    if (t) filters.push(eq(highlightReelsTable.tournamentId, tIdNum));
  }
  if (sinceValid) filters.push(gte(highlightReelsTable.createdAt, sinceValid));
  if (untilValid) filters.push(lte(highlightReelsTable.createdAt, untilValid));

  const rows = await db.select().from(highlightReelsTable)
    .where(and(...filters))
    .orderBy(desc(highlightReelsTable.createdAt))
    .limit(200);
  const counts = await fetchEngagementCounts(rows.map(r => r.id));

  // Surface the tournaments that have produced reels in this org so the UI
  // can populate its filter dropdown without a separate round-trip.
  const tournamentRows = await db.selectDistinct({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
  })
    .from(highlightReelsTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, highlightReelsTable.tournamentId))
    .where(eq(highlightReelsTable.organizationId, orgId))
    .orderBy(desc(tournamentsTable.id));

  res.json({
    reels: rows.map(r => decorate(r, { engagement: counts.get(r.id) })),
    tournaments: tournamentRows,
  });
});

// ── Create + queue render ────────────────────────────────────────────────────

router.post("/portal/highlights", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  // Task #469 — highlight reels stitch together photo/video media plus AI scoring.
  // Block render when the member has withdrawn either video or AI consent.
  if (!await requireConsent(req, res, "video")) return;
  if (!await requireConsent(req, res, "ai")) return;
  const orgId = await resolveOrgIdForCaller(req, caller, req.body?.organizationId);
  if (!orgId) { { res.status(400).json({ error: "No organization context" }); return; } }

  // Quota
  const quota = await quotaForOrg(orgId);
  const used = await rendersThisMonth(caller.userId, orgId);
  if (used >= quota) {
    res.status(429).json({
      error: "Highlight render quota reached for this month. Upgrade your plan for more renders.",
      quota: { monthlyLimit: quota, usedThisMonth: used },
    });
    return;
  }

  const { templateId, title, tournamentId, playerId, options } = req.body ?? {};
  const tpl = getTemplate(typeof templateId === "string" ? templateId : "classic");

  // ── Authorization for tournament/player references ────────────────────────
  // Anyone can guess IDs, so we MUST verify (a) tournament belongs to the
  // caller's org, and (b) the player row is the caller's own registration in
  // that tournament (matched by userId or by the caller's email).
  const tIdNum = tournamentId ? Number(tournamentId) : null;
  const pIdNum = playerId ? Number(playerId) : null;
  let validTournamentId: number | null = null;
  let validPlayerId: number | null = null;

  if (tIdNum) {
    const [t] = await db.select({ id: tournamentsTable.id, orgId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, tIdNum)).limit(1);
    if (!t || t.orgId !== orgId) {
      res.status(403).json({ error: "Tournament not accessible to this user" }); return;
    }
    validTournamentId = tIdNum;
  }

  if (pIdNum) {
    const [callerUser] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, caller.userId)).limit(1);
    const callerEmail = callerUser?.email ?? "";
    const [p] = await db.select({
      id: playersTable.id,
      tournamentId: playersTable.tournamentId,
      userId: playersTable.userId,
      email: playersTable.email,
    }).from(playersTable).where(eq(playersTable.id, pIdNum)).limit(1);
    if (!p) { { res.status(403).json({ error: "Player not accessible to this user" }); return; } }
    const ownsRegistration =
      (p.userId != null && p.userId === caller.userId) ||
      (callerEmail && p.email && p.email.toLowerCase() === callerEmail.toLowerCase());
    if (!ownsRegistration) {
      res.status(403).json({ error: "Player not accessible to this user" }); return;
    }
    if (validTournamentId && p.tournamentId !== validTournamentId) {
      res.status(400).json({ error: "Player does not belong to the supplied tournament" }); return;
    }
    // If only playerId was given, derive (and validate org of) tournamentId.
    if (!validTournamentId) {
      const [t] = await db.select({ orgId: tournamentsTable.organizationId })
        .from(tournamentsTable).where(eq(tournamentsTable.id, p.tournamentId)).limit(1);
      if (!t || t.orgId !== orgId) {
        res.status(403).json({ error: "Player not accessible to this user" }); return;
      }
      validTournamentId = p.tournamentId;
    }
    validPlayerId = pIdNum;
  }

  // Snapshot round summary at creation so re-renders use a stable snapshot
  const summary = await buildRoundSummary(validPlayerId, validTournamentId);

  // Best-effort enrich playerName from app user when no player record
  let snapshot: Record<string, unknown> = summary ? { ...summary } : {};
  if (!snapshot.playerName) {
    const [u] = await db.select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable).where(eq(appUsersTable.id, caller.userId)).limit(1);
    snapshot.playerName = u?.displayName || u?.username || "Player";
  }

  // Strip foreign mediaIds from options.clips before persisting so the row
  // can never reference media the caller isn't allowed to use.
  const safeOptions: Record<string, unknown> = (options && typeof options === "object") ? { ...options } : {};
  // Task #1961 — surface any source-video trim clamps on the response so
  // the editor can show a "Trimmed to fit the source video" notice next
  // to the affected clip(s) instead of silently shortening the player's
  // pick.
  let trimClampedMediaIds: number[] = [];
  if ("clips" in safeOptions) {
    const authorized = await authorizeClips(safeOptions.clips, {
      orgId, userId: caller.userId, tournamentId: validTournamentId,
    });
    safeOptions.clips = authorized?.clips ?? [];
    trimClampedMediaIds = authorized?.trimClampedMediaIds ?? [];
  }

  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgId,
    userId: caller.userId,
    tournamentId: validTournamentId,
    playerId: validPlayerId,
    templateId: tpl.id,
    title: typeof title === "string" && title.trim() ? title.trim() : "Round Highlights",
    options: safeOptions,
    summary: snapshot,
    status: "queued",
  }).returning();

  // Record the render attempt for quota accounting
  await db.insert(highlightRenderEventsTable).values({
    reelId: reel.id,
    organizationId: orgId,
    userId: caller.userId,
    trigger: "create",
  });

  // Hand off to the dedicated render worker process (Task #418). The API
  // server no longer spawns ffmpeg itself — it only writes the row and
  // returns immediately, so big videos can't slow down other requests.
  await enqueueRender(reel.id).catch(err =>
    logger.error({ err, reelId: reel.id }, "[highlight] enqueue failed"));

  res.status(201).json({ ...decorate(reel), trimClampedMediaIds });
});

// ── Update + re-render ───────────────────────────────────────────────────────

router.patch("/portal/highlights/:id", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [reel] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel || reel.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  if (reel.feedPostId) { { res.status(400).json({ error: "Cannot edit a reel that has been posted to the feed" }); return; } }
  if (reel.status === "rendering") { { res.status(409).json({ error: "Reel is currently rendering" }); return; } }

  // Re-render counts against quota (it's a fresh render).
  const quota = await quotaForOrg(reel.organizationId);
  const used = await rendersThisMonth(caller.userId, reel.organizationId);
  if (used >= quota) {
    res.status(429).json({ error: "Render quota reached for this month" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date(), status: "queued", errorMessage: null };
  const { templateId, title, options } = req.body ?? {};
  if (typeof templateId === "string") updates.templateId = getTemplate(templateId).id;
  if (typeof title === "string" && title.trim()) updates.title = title.trim();
  // Task #1961 — same trim-clamp surfacing as POST: PATCH re-runs the
  // authorize step, so it must report any clamps to the editor too.
  let trimClampedMediaIds: number[] = [];
  if (options && typeof options === "object") {
    const safeOptions: Record<string, unknown> = { ...options };
    if ("clips" in safeOptions) {
      const authorized = await authorizeClips(safeOptions.clips, {
        orgId: reel.organizationId,
        userId: caller.userId,
        tournamentId: reel.tournamentId,
      });
      safeOptions.clips = authorized?.clips ?? [];
      trimClampedMediaIds = authorized?.trimClampedMediaIds ?? [];
    }
    updates.options = { ...(reel.options as object), ...safeOptions };
  }

  const [updated] = await db.update(highlightReelsTable).set(updates).where(eq(highlightReelsTable.id, id)).returning();

  // Re-renders also consume monthly quota.
  await db.insert(highlightRenderEventsTable).values({
    reelId: updated.id,
    organizationId: updated.organizationId,
    userId: caller.userId,
    trigger: "rerender",
  });

  await enqueueRender(updated.id).catch(err =>
    logger.error({ err, reelId: updated.id }, "[highlight] re-enqueue failed"));
  res.json({ ...decorate(updated), trimClampedMediaIds });
});

// ── Delete ───────────────────────────────────────────────────────────────────

router.delete("/portal/highlights/:id", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [reel] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel || reel.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  await db.delete(highlightReelsTable).where(eq(highlightReelsTable.id, id));
  res.json({ ok: true });
});

// ── Post to feed ─────────────────────────────────────────────────────────────

router.post("/portal/highlights/:id/post-to-feed", async (req: Request, res: Response) => {
  const caller = getCaller(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  const [reel] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, id)).limit(1);
  if (!reel || reel.userId !== caller.userId) { { res.status(404).json({ error: "Not found" }); return; } }
  if (reel.status !== "ready" || !reel.outputObjectPath) {
    res.status(409).json({ error: "Reel is not ready to post yet" }); return;
  }
  if (reel.feedPostId) { { res.status(409).json({ error: "Reel already posted to the feed" }); return; } }

  const { body, privacy } = req.body ?? {};
  const [post] = await db.insert(feedPostsTable).values({
    organizationId: reel.organizationId,
    authorUserId: caller.userId,
    type: "member_post",
    body: (typeof body === "string" && body.trim()) ? body.trim() : (reel.title || "Round highlights"),
    privacy: privacy === "followers_only" ? "followers_only" : "all_members",
  }).returning();

  // Store the public-facing URL so feed viewers can stream the reel
  // (the underlying media row is registered + approved by the renderer).
  const publicUrl = publicUrlFor(reel.outputObjectPath);
  await db.insert(feedPostMediaTable).values({
    postId: post.id,
    url: publicUrl ?? reel.outputObjectPath,
    mimeType: "video/mp4",
    sortOrder: 0,
  });

  const [updated] = await db.update(highlightReelsTable).set({
    feedPostId: post.id,
    postedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(highlightReelsTable.id, id)).returning();

  res.status(201).json({ post, reel: decorate(updated) });
});

export default router;
