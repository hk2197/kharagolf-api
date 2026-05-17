import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  tournamentsTable, organizationsTable, sponsorsTable,
  teeTimesTable, teeTimePlayersTable, playersTable,
  coursesTable, holeDetailsTable, scoresTable, appUsersTable,
  broadcastOverlayStatesTable,
  broadcastOverlayStateTemplatesTable,
} from "@workspace/db";
import { eq, and, asc, isNull, or, sql, desc } from "drizzle-orm";
import { computeLeaderboard } from "../lib/realtime";
import { requireTournamentAccess } from "../lib/permissions";
import { resolveOrgBranding } from "../lib/clubTheming";

const router: IRouter = Router({ mergeParams: true });

/* ──────────────────────────────────────────────────────────────
 * Overlay producer state — persisted per tournament in the
 * `broadcast_overlay_states` table (Task #426) and mirrored in
 * an in-memory cache for read-heavy SSE traffic. Every producer
 * mutation is upserted to the DB before the SSE broadcast, so an
 * API restart mid-broadcast no longer wipes active overlays,
 * current group/hole/player, theme overrides, or lower-third text.
 * ────────────────────────────────────────────────────────────── */

export type OverlayType =
  | "leaderboard"
  | "lower-third"
  | "current-group"
  | "player-card"
  | "hole"
  | "sponsor-bug";

export type OverlayTheme = {
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  sponsorPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  showSafeArea: boolean;
};

export type OverlayState = {
  active: Record<OverlayType, boolean>;
  currentGroupId: number | null;
  currentHole: number | null;
  currentPlayerId: number | null;
  currentSponsorId: number | null;
  lowerThirdText: string | null;
  leaderboardLimit: number;
  theme: OverlayTheme;
  updatedAt: string;
};

const DEFAULT_THEME: OverlayTheme = {
  logoUrl: null,
  primaryColor: "#22c55e",
  accentColor: "#C9A84C",
  sponsorPosition: "bottom-right",
  showSafeArea: false,
};

function defaultState(branding?: { logoUrl: string | null; primaryColor: string | null } | null): OverlayState {
  return {
    active: {
      leaderboard: false,
      "lower-third": false,
      "current-group": false,
      "player-card": false,
      hole: false,
      "sponsor-bug": false,
    },
    currentGroupId: null,
    currentHole: null,
    currentPlayerId: null,
    currentSponsorId: null,
    lowerThirdText: null,
    leaderboardLimit: 10,
    theme: {
      ...DEFAULT_THEME,
      logoUrl: branding?.logoUrl ?? DEFAULT_THEME.logoUrl,
      primaryColor: branding?.primaryColor ?? DEFAULT_THEME.primaryColor,
    },
    updatedAt: new Date().toISOString(),
  };
}

// In-memory cache mirrors the persisted row so that read-heavy SSE traffic
// doesn't hit the DB on every tick. Mutations always persist, then update
// the cache. On first read after a server restart we lazily hydrate the
// cache from `broadcast_overlay_states`.
const overlayStates = new Map<number, OverlayState>();
const overlayClients = new Map<number, Set<Response>>();

function mergeWithDefaults(
  raw: unknown,
  branding?: { logoUrl: string | null; primaryColor: string | null } | null,
): OverlayState {
  const base = defaultState(branding);
  const r = (raw ?? {}) as Partial<OverlayState>;
  return {
    active: { ...base.active, ...((r.active as OverlayState["active"]) ?? {}) },
    currentGroupId: r.currentGroupId ?? null,
    currentHole: r.currentHole ?? null,
    currentPlayerId: r.currentPlayerId ?? null,
    currentSponsorId: r.currentSponsorId ?? null,
    lowerThirdText: r.lowerThirdText ?? null,
    leaderboardLimit: typeof r.leaderboardLimit === "number" ? r.leaderboardLimit : base.leaderboardLimit,
    theme: { ...base.theme, ...((r.theme as OverlayTheme) ?? {}) },
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : base.updatedAt,
  };
}

async function getState(
  tournamentId: number,
  branding?: { logoUrl: string | null; primaryColor: string | null } | null,
): Promise<OverlayState> {
  const cached = overlayStates.get(tournamentId);
  if (cached) return cached;
  const [row] = await db
    .select({ state: broadcastOverlayStatesTable.state })
    .from(broadcastOverlayStatesTable)
    .where(eq(broadcastOverlayStatesTable.tournamentId, tournamentId));
  const s = row ? mergeWithDefaults(row.state, branding) : defaultState(branding);
  overlayStates.set(tournamentId, s);
  return s;
}

async function persistState(tournamentId: number, state: OverlayState): Promise<void> {
  overlayStates.set(tournamentId, state);
  await db
    .insert(broadcastOverlayStatesTable)
    .values({ tournamentId, state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: broadcastOverlayStatesTable.tournamentId,
      set: { state, updatedAt: sql`now()` },
    });
}

async function broadcastState(tournamentId: number) {
  const s = await getState(tournamentId);
  const payload = `data: ${JSON.stringify({ type: "overlay_state", data: s })}\n\n`;
  const set = overlayClients.get(tournamentId);
  if (!set) return;
  for (const client of set) {
    try { client.write(payload); } catch { set.delete(client); }
  }
}


/* ──────────────────────────────────────────────────────────────
 * Public overlay routes — designed as transparent OBS / vMix
 * browser sources. No auth required: anyone with the tournament
 * ID can render overlays. The tournament must exist.
 * ────────────────────────────────────────────────────────────── */

async function loadOrgBranding(orgId: number) {
  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) return null;
  // Task #1758 — let the saved club_theming row override the legacy
  // organizations.* columns so broadcast overlays show the logo / primary
  // colour the admin most recently picked in the club-theming UI.
  const branded = await resolveOrgBranding(orgId, org);
  return {
    name: org.name,
    logoUrl: branded.logoUrl ?? null,
    primaryColor: branded.primaryColor ?? null,
  };
}

// GET /api/public/overlays/:tournamentId/state
// Snapshot of the producer state + theme + tournament/org branding.
// Browser sources should fetch this once on load, then subscribe to /stream.
router.get("/public/overlays/:tournamentId/state", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const [t] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    organizationId: tournamentsTable.organizationId,
    format: tournamentsTable.format,
    status: tournamentsTable.status,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const org = await loadOrgBranding(t.organizationId);
  const state = await getState(tournamentId, org);

  // Apply org defaults to theme when not overridden
  const theme: OverlayTheme = {
    logoUrl: state.theme.logoUrl ?? org?.logoUrl ?? null,
    primaryColor: state.theme.primaryColor || (org?.primaryColor ?? DEFAULT_THEME.primaryColor),
    accentColor: state.theme.accentColor || DEFAULT_THEME.accentColor,
    sponsorPosition: state.theme.sponsorPosition,
    showSafeArea: state.theme.showSafeArea,
  };

  res.json({
    tournament: { id: t.id, name: t.name, format: t.format, status: t.status },
    org: { id: t.organizationId, name: org?.name ?? null, logoUrl: org?.logoUrl ?? null, primaryColor: org?.primaryColor ?? null },
    state: { ...state, theme },
  });
});

// GET /api/public/overlays/:tournamentId/leaderboard?limit=10
router.get("/public/overlays/:tournamentId/leaderboard", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const limit = Math.max(1, Math.min(20, parseInt((req.query.limit as string) ?? "10")));
  const lb = await computeLeaderboard(tournamentId);
  if (!lb) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  const entries = (lb.entries ?? [])
    .filter((e) => !e.dns)
    .slice(0, limit)
    .map((e) => ({
      position: e.position,
      positionDisplay: e.positionDisplay,
      playerId: e.playerId,
      playerName: e.playerName,
      thru: e.thru,
      grossScore: e.grossScore,
      scoreToPar: e.scoreToPar,
      netScore: e.netScore,
      netToPar: e.netToPar,
    }));
  res.json({ tournamentName: lb.tournamentName, coursePar: lb.coursePar, lastUpdated: lb.lastUpdated, entries });
});

async function loadGroup(tournamentId: number, groupId: number) {
  const [tt] = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.id, groupId), eq(teeTimesTable.tournamentId, tournamentId)));
  if (!tt) return null;

  const lb = await computeLeaderboard(tournamentId);
  const entryMap = new Map((lb?.entries ?? []).map((e) => [e.playerId, e]));

  const players = await db.select({
    playerId: teeTimePlayersTable.playerId,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
    flight: playersTable.flight,
    handicapIndex: playersTable.handicapIndex,
  }).from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
    .where(eq(teeTimePlayersTable.teeTimeId, groupId));

  return {
    id: tt.id,
    teeTime: tt.teeTime.toISOString(),
    startingHole: tt.startingHole,
    round: tt.round,
    players: players.map((p) => {
      const e = entryMap.get(p.playerId);
      return {
        playerId: p.playerId,
        playerName: `${p.firstName} ${p.lastName}`,
        flight: p.flight,
        handicapIndex: p.handicapIndex ? Number(p.handicapIndex) : null,
        position: e?.position ?? null,
        positionDisplay: e?.positionDisplay ?? null,
        scoreToPar: e?.scoreToPar ?? null,
        thru: e?.thru ?? null,
        currentHole: e?.currentHole ?? null,
      };
    }),
  };
}

// GET /api/public/overlays/:tournamentId/group/:groupId
router.get("/public/overlays/:tournamentId/group/:groupId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const groupId = parseInt(String((req.params as Record<string, string>).groupId));
  const group = await loadGroup(tournamentId, groupId);
  if (!group) { { res.status(404).json({ error: "Group not found" }); return; } }
  res.json(group);
});

// GET /api/public/overlays/:tournamentId/player/:playerId
router.get("/public/overlays/:tournamentId/player/:playerId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const [player] = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
    flight: playersTable.flight,
    handicapIndex: playersTable.handicapIndex,
    teamName: playersTable.teamName,
    userId: playersTable.userId,
  }).from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  let profileImage: string | null = null;
  if (player.userId) {
    const [u] = await db.select({ profileImage: appUsersTable.profileImage })
      .from(appUsersTable).where(eq(appUsersTable.id, player.userId));
    profileImage = u?.profileImage ?? null;
  }

  const lb = await computeLeaderboard(tournamentId);
  const entry = lb?.entries.find((e) => e.playerId === playerId) ?? null;

  res.json({
    playerId: player.id,
    playerName: `${player.firstName} ${player.lastName}`,
    flight: player.flight,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
    teamName: player.teamName,
    profileImage,
    position: entry?.position ?? null,
    positionDisplay: entry?.positionDisplay ?? null,
    grossScore: entry?.grossScore ?? null,
    scoreToPar: entry?.scoreToPar ?? null,
    netScore: entry?.netScore ?? null,
    netToPar: entry?.netToPar ?? null,
    thru: entry?.thru ?? null,
    currentRound: entry?.currentRound ?? null,
    stats: entry?.stats ?? null,
    holeScores: entry?.holeScores ?? [],
  });
});

// GET /api/public/overlays/:tournamentId/hole/:holeNumber
router.get("/public/overlays/:tournamentId/hole/:holeNumber", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));

  const [t] = await db.select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!t || !t.courseId) { { res.status(404).json({ error: "Tournament or course not found" }); return; } }

  const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, t.courseId));
  const [hole] = await db.select().from(holeDetailsTable)
    .where(and(eq(holeDetailsTable.courseId, t.courseId), eq(holeDetailsTable.holeNumber, holeNumber)));
  if (!hole) { { res.status(404).json({ error: "Hole not found" }); return; } }

  // Hole-level scoring summary
  const holeScores = await db.select({ strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.holeNumber, holeNumber)));

  const totalScored = holeScores.length;
  const eagles = holeScores.filter((s) => s.strokes - hole.par <= -2).length;
  const birdies = holeScores.filter((s) => s.strokes - hole.par === -1).length;
  const pars = holeScores.filter((s) => s.strokes - hole.par === 0).length;
  const bogeys = holeScores.filter((s) => s.strokes - hole.par === 1).length;
  const doublePlus = holeScores.filter((s) => s.strokes - hole.par >= 2).length;
  const avgStrokes = totalScored > 0
    ? +(holeScores.reduce((a, s) => a + s.strokes, 0) / totalScored).toFixed(2)
    : null;

  res.json({
    courseName: course?.name ?? null,
    holeNumber: hole.holeNumber,
    par: hole.par,
    yardage: hole.yardageWhite ?? hole.yardageBlue ?? hole.yardageRed ?? null,
    handicap: hole.handicap ?? null,
    description: hole.description ?? null,
    stats: { totalScored, eagles, birdies, pars, bogeys, doublePlus, avgStrokes },
  });
});

// GET /api/public/overlays/:tournamentId/sponsor
router.get("/public/overlays/:tournamentId/sponsor", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const [t] = await db.select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const sponsors = await db.select({
    id: sponsorsTable.id,
    name: sponsorsTable.name,
    logoUrl: sponsorsTable.logoUrl,
    tier: sponsorsTable.tier,
    websiteUrl: sponsorsTable.websiteUrl,
  }).from(sponsorsTable)
    .where(and(
      eq(sponsorsTable.organizationId, t.organizationId),
      eq(sponsorsTable.isActive, true),
      or(isNull(sponsorsTable.tournamentId), eq(sponsorsTable.tournamentId, tournamentId)),
    ))
    .orderBy(asc(sponsorsTable.displayOrder));

  res.json({ sponsors });
});

// GET /api/public/overlays/:tournamentId/stream — SSE for cue + state changes
router.get("/public/overlays/:tournamentId/stream", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const [t] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  // Send initial snapshot
  res.write(`data: ${JSON.stringify({ type: "overlay_state", data: await getState(tournamentId) })}\n\n`);

  if (!overlayClients.has(tournamentId)) overlayClients.set(tournamentId, new Set());
  overlayClients.get(tournamentId)!.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    overlayClients.get(tournamentId)?.delete(res);
  });
});

/* ──────────────────────────────────────────────────────────────
 * Producer control panel — admin only.
 * ────────────────────────────────────────────────────────────── */

// GET /api/organizations/:orgId/tournaments/:tournamentId/overlay-state
router.get("/organizations/:orgId/tournaments/:tournamentId/overlay-state", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const org = await loadOrgBranding(orgId);
  res.json(await getState(tournamentId, org));
});

// PUT /api/organizations/:orgId/tournaments/:tournamentId/overlay-state
// Replaces the producer state. Body may include any subset of fields.
router.put("/organizations/:orgId/tournaments/:tournamentId/overlay-state", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const cur = await getState(tournamentId);
  const b = req.body ?? {};
  const next: OverlayState = {
    active: { ...cur.active, ...(b.active ?? {}) },
    currentGroupId: b.currentGroupId !== undefined ? (b.currentGroupId === null ? null : parseInt(b.currentGroupId)) : cur.currentGroupId,
    currentHole: b.currentHole !== undefined ? (b.currentHole === null ? null : parseInt(b.currentHole)) : cur.currentHole,
    currentPlayerId: b.currentPlayerId !== undefined ? (b.currentPlayerId === null ? null : parseInt(b.currentPlayerId)) : cur.currentPlayerId,
    currentSponsorId: b.currentSponsorId !== undefined ? (b.currentSponsorId === null ? null : parseInt(b.currentSponsorId)) : cur.currentSponsorId,
    lowerThirdText: b.lowerThirdText !== undefined ? (b.lowerThirdText || null) : cur.lowerThirdText,
    leaderboardLimit: b.leaderboardLimit !== undefined ? Math.max(1, Math.min(20, parseInt(b.leaderboardLimit))) : cur.leaderboardLimit,
    theme: { ...cur.theme, ...(b.theme ?? {}) },
    updatedAt: new Date().toISOString(),
  };

  await persistState(tournamentId, next);
  await broadcastState(tournamentId);
  res.json(next);
});

// POST /api/organizations/:orgId/tournaments/:tournamentId/overlay-cue
// Quick cue: e.g. { type: "hole", value: 17 } or { type: "active", overlay: "lower-third", on: true }
router.post("/organizations/:orgId/tournaments/:tournamentId/overlay-cue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const { type, value, overlay, on } = req.body ?? {};
  const s = await getState(tournamentId);

  switch (type) {
    case "active":
      if (overlay && overlay in s.active) {
        s.active[overlay as OverlayType] = !!on;
      }
      break;
    case "hole":
      s.currentHole = value === null ? null : parseInt(value);
      break;
    case "group":
      s.currentGroupId = value === null ? null : parseInt(value);
      break;
    case "player":
      s.currentPlayerId = value === null ? null : parseInt(value);
      break;
    case "sponsor":
      s.currentSponsorId = value === null ? null : parseInt(value);
      break;
    case "lower-third":
      s.lowerThirdText = value || null;
      s.active["lower-third"] = !!value;
      break;
    case "clear-all":
      for (const k of Object.keys(s.active) as OverlayType[]) s.active[k] = false;
      break;
    default:
      res.status(400).json({ error: "Unknown cue type" });
      return;
  }

  s.updatedAt = new Date().toISOString();
  await persistState(tournamentId, s);
  await broadcastState(tournamentId);
  res.json(s);
});

/* ──────────────────────────────────────────────────────────────
 * Producer cue-sheet templates — Task #549. Producers can save
 * named overlay states ("Sunday final round", "Hole 17 amen
 * corner") per tournament and load any of them on demand to
 * replace the live cue state. Templates are scoped to the
 * tournament's organisation and protected by the same
 * tournament-access checks as the live state endpoints.
 * ────────────────────────────────────────────────────────────── */

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string; cause?: unknown; message?: string };
  const cause = e.cause as { code?: string; constraint?: string; message?: string } | undefined;
  const isUnique = e.code === "23505" || cause?.code === "23505";
  if (!isUnique) return false;
  if (e.constraint === constraint || cause?.constraint === constraint) return true;
  const msg = `${e.message ?? ""} ${cause?.message ?? ""}`;
  return msg.includes(constraint);
}

function normaliseTemplateName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return null;
  return trimmed;
}

// GET /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates
router.get("/organizations/:orgId/tournaments/:tournamentId/overlay-templates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const rows = await db
    .select({
      id: broadcastOverlayStateTemplatesTable.id,
      name: broadcastOverlayStateTemplatesTable.name,
      state: broadcastOverlayStateTemplatesTable.state,
      createdByUserId: broadcastOverlayStateTemplatesTable.createdByUserId,
      createdAt: broadcastOverlayStateTemplatesTable.createdAt,
      updatedAt: broadcastOverlayStateTemplatesTable.updatedAt,
      lastLoadedAt: broadcastOverlayStateTemplatesTable.lastLoadedAt,
      lastLoadedByUserId: broadcastOverlayStateTemplatesTable.lastLoadedByUserId,
    })
    .from(broadcastOverlayStateTemplatesTable)
    .where(and(
      eq(broadcastOverlayStateTemplatesTable.tournamentId, tournamentId),
      eq(broadcastOverlayStateTemplatesTable.organizationId, orgId),
    ))
    .orderBy(desc(broadcastOverlayStateTemplatesTable.updatedAt));

  res.json({ templates: rows });
});

// POST /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates
// Body: { name: string, state?: OverlayState }
// When `state` is omitted, the current live cue state is captured.
router.post("/organizations/:orgId/tournaments/:tournamentId/overlay-templates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const name = normaliseTemplateName(req.body?.name);
  if (!name) { { res.status(400).json({ error: "Template name is required (1-120 chars)." }); return; } }

  const snapshot = req.body?.state
    ? mergeWithDefaults(req.body.state)
    : await getState(tournamentId);

  const userId = (req.user as { id?: number } | undefined)?.id ?? null;

  try {
    const [row] = await db
      .insert(broadcastOverlayStateTemplatesTable)
      .values({
        tournamentId,
        organizationId: orgId,
        name,
        state: snapshot,
        createdByUserId: userId,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    if (isUniqueViolation(err, "broadcast_overlay_template_tournament_name_unique")) {
      res.status(409).json({ error: "A template with that name already exists for this tournament." });
      return;
    }
    throw err;
  }
});

// PUT /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId
// Body: { name?: string, state?: OverlayState }
// Used to rename a template or refresh its captured state.
router.put("/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const [existing] = await db
    .select()
    .from(broadcastOverlayStateTemplatesTable)
    .where(and(
      eq(broadcastOverlayStateTemplatesTable.id, templateId),
      eq(broadcastOverlayStateTemplatesTable.tournamentId, tournamentId),
      eq(broadcastOverlayStateTemplatesTable.organizationId, orgId),
    ));
  if (!existing) { { res.status(404).json({ error: "Template not found." }); return; } }

  const update: Partial<{ name: string; state: OverlayState; updatedAt: Date }> = { updatedAt: new Date() };
  if (req.body?.name !== undefined) {
    const name = normaliseTemplateName(req.body.name);
    if (!name) { { res.status(400).json({ error: "Template name is required (1-120 chars)." }); return; } }
    update.name = name;
  }
  if (req.body?.state !== undefined) {
    update.state = mergeWithDefaults(req.body.state);
  }

  try {
    const [row] = await db
      .update(broadcastOverlayStateTemplatesTable)
      .set(update)
      .where(eq(broadcastOverlayStateTemplatesTable.id, templateId))
      .returning();
    res.json(row);
  } catch (err) {
    if (isUniqueViolation(err, "broadcast_overlay_template_tournament_name_unique")) {
      res.status(409).json({ error: "A template with that name already exists for this tournament." });
      return;
    }
    throw err;
  }
});

// DELETE /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId
router.delete("/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const result = await db
    .delete(broadcastOverlayStateTemplatesTable)
    .where(and(
      eq(broadcastOverlayStateTemplatesTable.id, templateId),
      eq(broadcastOverlayStateTemplatesTable.tournamentId, tournamentId),
      eq(broadcastOverlayStateTemplatesTable.organizationId, orgId),
    ))
    .returning({ id: broadcastOverlayStateTemplatesTable.id });
  if (result.length === 0) { { res.status(404).json({ error: "Template not found." }); return; } }
  res.json({ deleted: true });
});

// POST /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId/load
// Loads the named template into the live cue state and broadcasts it to viewers.
router.post("/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId/load", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const templateId = parseInt(String((req.params as Record<string, string>).templateId));
  if (!(await requireTournamentAccess(req, res, orgId, tournamentId))) return;

  const [tpl] = await db
    .select({ state: broadcastOverlayStateTemplatesTable.state })
    .from(broadcastOverlayStateTemplatesTable)
    .where(and(
      eq(broadcastOverlayStateTemplatesTable.id, templateId),
      eq(broadcastOverlayStateTemplatesTable.tournamentId, tournamentId),
      eq(broadcastOverlayStateTemplatesTable.organizationId, orgId),
    ));
  if (!tpl) { { res.status(404).json({ error: "Template not found." }); return; } }

  const next: OverlayState = {
    ...mergeWithDefaults(tpl.state),
    updatedAt: new Date().toISOString(),
  };
  await persistState(tournamentId, next);

  // Task #726 — record who loaded this template and when so producers
  // sharing a tournament can coordinate and so post-event review can
  // tell which template was on-air at any given time.
  const loadedByUserId = (req.user as { id?: number } | undefined)?.id ?? null;
  await db
    .update(broadcastOverlayStateTemplatesTable)
    .set({ lastLoadedAt: new Date(), lastLoadedByUserId: loadedByUserId })
    .where(eq(broadcastOverlayStateTemplatesTable.id, templateId));

  await broadcastState(tournamentId);
  res.json(next);
});

export default router;
