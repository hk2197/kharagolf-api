import { type Response } from "express";
import { db } from "@workspace/db";
import {
  scoresTable, playersTable, holeDetailsTable,
  tournamentsTable, flightsTable, playerFlightsTable, coursesTable, appUsersTable,
  tournamentRoundsTable, eventTeamsTable, eventTeamMembersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  computePlayingHandicap,
  stablefordPointsForHole,
  strokesOnHole,
  effectiveHandicapIndex,
  type StablefordPointsConfig,
} from "./handicap";
import { translateSpectatorPush } from "./spectatorPushI18n";

// SSE client registry: tournamentId → Set of response objects
const clients = new Map<number, Set<Response>>();
// Per-SSE-client preferred language (Task #802 — translate spectator
// highlight events on web spectator dashboards too).
const clientLang = new WeakMap<Response, string>();

export function addSSEClient(tournamentId: number, res: Response, lang?: string | null) {
  if (!clients.has(tournamentId)) {
    clients.set(tournamentId, new Set());
  }
  clients.get(tournamentId)!.add(res);
  if (lang) clientLang.set(res, lang);
}

export function removeSSEClient(tournamentId: number, res: Response) {
  clients.get(tournamentId)?.delete(res);
  clientLang.delete(res);
}

export function notifyLeaderboardUpdate(tournamentId: number, data: unknown) {
  const tournamentClients = clients.get(tournamentId);
  if (tournamentClients) {
    const message = `data: ${JSON.stringify({ type: "leaderboard_update", data })}\n\n`;
    for (const client of tournamentClients) {
      try {
        client.write(message);
      } catch {
        tournamentClients.delete(client);
      }
    }
  }

  // Task #454 — fan out a fresh odds payload to any connected odds-stream
  // clients whenever the leaderboard moves. Coalesced + lazy: skipped when
  // no odds clients are connected for this tournament.
  scheduleOddsBroadcast(tournamentId);
}

/* ─── Live Odds SSE (Task #454) ────────────────────────────────────── */
// Same payload as buildOddsPayload(), pushed in real time alongside
// leaderboard updates so the win-probability widget never has to poll.

const oddsClients = new Map<number, Set<Response>>();
const oddsBroadcastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const ODDS_BROADCAST_DEBOUNCE_MS = 1000;

export function addOddsClient(tournamentId: number, res: Response) {
  if (!oddsClients.has(tournamentId)) oddsClients.set(tournamentId, new Set());
  oddsClients.get(tournamentId)!.add(res);
}

export function removeOddsClient(tournamentId: number, res: Response) {
  oddsClients.get(tournamentId)?.delete(res);
}

export function hasOddsClients(tournamentId: number): boolean {
  return (oddsClients.get(tournamentId)?.size ?? 0) > 0;
}

export function notifyOddsUpdate(tournamentId: number, payload: unknown) {
  const set = oddsClients.get(tournamentId);
  if (!set) return;
  const message = `data: ${JSON.stringify({ type: "odds_update", data: payload })}\n\n`;
  for (const client of set) {
    try { client.write(message); } catch { set.delete(client); }
  }
}

function scheduleOddsBroadcast(tournamentId: number) {
  if (!hasOddsClients(tournamentId)) return;
  if (oddsBroadcastTimers.has(tournamentId)) return; // already pending
  const timer = setTimeout(async () => {
    oddsBroadcastTimers.delete(tournamentId);
    if (!hasOddsClients(tournamentId)) return;
    try {
      // Dynamic import avoids a circular dependency with ./odds
      const { buildOddsPayload } = await import("./odds");
      const payload = await buildOddsPayload(tournamentId);
      if (payload) notifyOddsUpdate(tournamentId, payload);
    } catch {
      /* swallow — odds broadcast is best-effort */
    }
  }, ODDS_BROADCAST_DEBOUNCE_MS);
  oddsBroadcastTimers.set(tournamentId, timer);
}

export type ScoringEvent = {
  tournamentId: number;
  playerId?: number;
  playerName: string;
  holeNumber: number;
  strokes: number;
  par: number;
  toPar: number;
  eventType: "hole_in_one" | "eagle" | "birdie" | "round_start" | "round_finish" | "tee_off";
  occurredAt: string;
  round?: number;
};

// In-memory notable-events ring buffer per tournament for spectator backlog.
const notableEventsLog = new Map<number, ScoringEvent[]>();
const NOTABLE_EVENTS_MAX = 100;

export function recordNotableEvent(tournamentId: number, event: ScoringEvent) {
  const list = notableEventsLog.get(tournamentId) ?? [];
  list.push(event);
  if (list.length > NOTABLE_EVENTS_MAX) list.shift();
  notableEventsLog.set(tournamentId, list);
}

export function getNotableEvents(tournamentId: number, limit = 50): ScoringEvent[] {
  const list = notableEventsLog.get(tournamentId) ?? [];
  return list.slice(-limit).reverse();
}

export function notifyScoringEvent(tournamentId: number, event: ScoringEvent) {
  recordNotableEvent(tournamentId, event);
  const tournamentClients = clients.get(tournamentId);
  if (!tournamentClients) return;
  // Translate per-client so each spectator's SSE feed carries title/body
  // strings in their preferred language (Task #802). Falls back to English
  // when the client did not advertise a language at subscription time.
  for (const client of tournamentClients) {
    const lang = clientLang.get(client) ?? "en";
    const { title, body } = translateSpectatorPush(lang, event);
    const message = `data: ${JSON.stringify({ type: "scoring_event", data: { ...event, title, body, lang } })}\n\n`;
    try { client.write(message); } catch { tournamentClients.delete(client); }
  }
}

export type HoleScoreEnteredEvent = {
  tournamentId: number;
  playerId: number;
  playerName: string;
  holeNumber: number;
  strokes: number;
  round: number;
  occurredAt: string;
};

export function notifyHoleScoreEntered(tournamentId: number, event: HoleScoreEnteredEvent) {
  const tournamentClients = clients.get(tournamentId);
  if (!tournamentClients) return;
  const message = `data: ${JSON.stringify({ type: "hole_score_entered", data: event })}\n\n`;
  for (const client of tournamentClients) {
    try { client.write(message); } catch { tournamentClients.delete(client); }
  }
}

/* ─── Marker Live View SSE ─────────────────────────────────────────── */
// Keyed by markerShareToken string — allows token-only auth for the marker

const markerLiveClients = new Map<string, Set<Response>>();

export function addMarkerLiveClient(token: string, res: Response) {
  if (!markerLiveClients.has(token)) markerLiveClients.set(token, new Set());
  markerLiveClients.get(token)!.add(res);
}

export function removeMarkerLiveClient(token: string, res: Response) {
  markerLiveClients.get(token)?.delete(res);
}

export function notifyMarkerLiveScore(token: string, event: HoleScoreEnteredEvent) {
  const tokenClients = markerLiveClients.get(token);
  if (!tokenClients) return;
  const message = `data: ${JSON.stringify({ type: "hole_score_entered", data: event })}\n\n`;
  for (const client of tokenClients) {
    try { client.write(message); } catch { tokenClients.delete(client); }
  }
}

/* ─── Announcements ────────────────────────────────────────────────── */

export type Announcement = { id: number; text: string; author: string; at: string; scope: string };

// scope: "tournament_<id>" | "league_<id>"
const announcementLog = new Map<string, Announcement[]>();
const announcementClients = new Map<string, Set<Response>>();

export function addAnnouncementClient(scope: string, res: Response) {
  if (!announcementClients.has(scope)) announcementClients.set(scope, new Set());
  announcementClients.get(scope)!.add(res);
}

export function removeAnnouncementClient(scope: string, res: Response) {
  announcementClients.get(scope)?.delete(res);
}

export function broadcastAnnouncement(scope: string, text: string, author: string): Announcement {
  const entry: Announcement = { id: Date.now(), text: text.trim(), author, at: new Date().toISOString(), scope };
  const list = announcementLog.get(scope) ?? [];
  list.push(entry);
  if (list.length > 100) list.shift();
  announcementLog.set(scope, list);

  const payload = `data: ${JSON.stringify({ type: "announcement", data: entry })}\n\n`;
  const scopeClients = announcementClients.get(scope);
  if (scopeClients) {
    for (const client of scopeClients) {
      try { client.write(payload); } catch { scopeClients.delete(client); }
    }
  }
  return entry;
}

export function getAnnouncements(scope: string): Announcement[] {
  return announcementLog.get(scope) ?? [];
}

/* ─── Chat ─────────────────────────────────────────────────────────── */

type ChatMsg = {
  id: number;
  roomId: number;
  userId: number | null;
  displayName: string;
  body: string;
  isPinned: boolean;
  createdAt: Date | string;
};

const chatLog = new Map<number, ChatMsg[]>();
const chatClients = new Map<number, Set<Response>>();

export function addChatClient(roomId: number, res: Response) {
  if (!chatClients.has(roomId)) chatClients.set(roomId, new Set());
  chatClients.get(roomId)!.add(res);
}

export function removeChatClient(roomId: number, res: Response) {
  chatClients.get(roomId)?.delete(res);
}

export function broadcastChatMessage(roomId: number, msg: ChatMsg) {
  const list = chatLog.get(roomId) ?? [];
  const existing = list.findIndex((m) => m.id === msg.id);
  if (existing >= 0) list[existing] = msg; else list.push(msg);
  if (list.length > 200) list.shift();
  chatLog.set(roomId, list);

  const payload = `data: ${JSON.stringify({ type: "chat_message", data: msg })}\n\n`;
  const clients = chatClients.get(roomId);
  if (clients) {
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  }
}

export function getChatBacklog(roomId: number): ChatMsg[] {
  return chatLog.get(roomId) ?? [];
}

export function broadcastChatDeletion(roomId: number, msgId: number) {
  const list = chatLog.get(roomId);
  if (list) chatLog.set(roomId, list.filter((m) => m.id !== msgId));

  const payload = `data: ${JSON.stringify({ type: "chat_message_deleted", data: { id: msgId, roomId } })}\n\n`;
  const clients = chatClients.get(roomId);
  if (clients) {
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  }
}

export function broadcastChatCleared(roomId: number) {
  chatLog.delete(roomId);

  const payload = `data: ${JSON.stringify({ type: "chat_cleared", data: { roomId } })}\n\n`;
  const clients = chatClients.get(roomId);
  if (clients) {
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  }
}

// ─── Match Play Bracket SSE ────────────────────────────────────────────────

const bracketClients = new Map<number, Set<Response>>();

export function addBracketClient(tournamentId: number, res: Response) {
  if (!bracketClients.has(tournamentId)) bracketClients.set(tournamentId, new Set());
  bracketClients.get(tournamentId)!.add(res);
}

export function removeBracketClient(tournamentId: number, res: Response) {
  bracketClients.get(tournamentId)?.delete(res);
}

export function broadcastBracketUpdate(tournamentId: number, data: unknown) {
  const payload = `data: ${JSON.stringify({ type: "bracket_update", data })}\n\n`;
  const set = bracketClients.get(tournamentId);
  if (set) {
    for (const client of set) {
      try { client.write(payload); } catch { set.delete(client); }
    }
  }
}

// ─── Ryder Cup SSE ────────────────────────────────────────────────────────

const ryderCupClients = new Map<number, Set<Response>>();

export function addRyderCupClient(tournamentId: number, res: Response) {
  if (!ryderCupClients.has(tournamentId)) ryderCupClients.set(tournamentId, new Set());
  ryderCupClients.get(tournamentId)!.add(res);
}

export function removeRyderCupClient(tournamentId: number, res: Response) {
  ryderCupClients.get(tournamentId)?.delete(res);
}

export function broadcastRyderCupUpdate(tournamentId: number, data: unknown) {
  const payload = `data: ${JSON.stringify({ type: "ryder_cup_update", data })}\n\n`;
  const set = ryderCupClients.get(tournamentId);
  if (set) {
    for (const client of set) {
      try { client.write(payload); } catch { set.delete(client); }
    }
  }
}

type RoundScore = {
  round: number;
  grossScore: number;
  scoreToPar: number;
  netScore: number | null;
  stablefordPoints: number | null;
  holesPlayed: number;
  isComplete: boolean;
};

type LeaderboardEntry = {
  position: number;
  positionDisplay: string;
  playerId: number;
  userId: number | null;
  playerName: string;
  profileImage: string | null;
  flights: string[];
  handicapIndex: number;
  playingHandicap: number;
  grossScore: number | null;
  netScore: number | null;
  scoreToPar: number | null;
  netToPar: number | null;
  stablefordPoints: number | null;
  parBogeyScore: number | null;
  holesCompleted: number;
  currentHole: number | null;
  holeScores: { hole: number; round: number; strokes: number; rawStrokes?: number; par: number; toPar: number; netToPar: number; strokeIndex: number | null; stablefordPoints: number; parBogeyResult: "W" | "L" | "H" | null; isVerified: boolean; putts: number | null; fairwayHit: boolean | null; girHit: boolean | null }[];
  thru: string;
  currentRound: number;
  roundScores: RoundScore[];
  madeCut: boolean | null;
  checkedIn: boolean;
  dns: boolean;
  teeBox: string | null;
  stats: {
    eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number;
    fairwaysHit: number; fairwayOpportunities: number; girHit: number; totalPutts: number;
    avgPutts: number | null;
  };
  isVerified: boolean;
  teamId: number | null;
  teamName: string | null;
};

function countbackCurrentRound(a: LeaderboardEntry, b: LeaderboardEntry): number {
  const aRoundHoles = a.holeScores.filter(h => h.round === a.currentRound);
  const bRoundHoles = b.holeScores.filter(h => h.round === b.currentRound);
  if (aRoundHoles.length < 18 || bRoundHoles.length < 18) return b.holesCompleted - a.holesCompleted;
  const aLast9 = aRoundHoles.filter(h => h.hole >= 10).reduce((s, h) => s + h.toPar, 0);
  const bLast9 = bRoundHoles.filter(h => h.hole >= 10).reduce((s, h) => s + h.toPar, 0);
  if (aLast9 !== bLast9) return aLast9 - bLast9;
  const aLast6 = aRoundHoles.filter(h => h.hole >= 13).reduce((s, h) => s + h.toPar, 0);
  const bLast6 = bRoundHoles.filter(h => h.hole >= 13).reduce((s, h) => s + h.toPar, 0);
  if (aLast6 !== bLast6) return aLast6 - bLast6;
  const aLast3 = aRoundHoles.filter(h => h.hole >= 16).reduce((s, h) => s + h.toPar, 0);
  const bLast3 = bRoundHoles.filter(h => h.hole >= 16).reduce((s, h) => s + h.toPar, 0);
  if (aLast3 !== bLast3) return aLast3 - bLast3;
  const aLast1 = aRoundHoles.find(h => h.hole === 18)?.toPar ?? 0;
  const bLast1 = bRoundHoles.find(h => h.hole === 18)?.toPar ?? 0;
  return aLast1 - bLast1;
}

function sortByToPar(entries: LeaderboardEntry[], mode: "gross" | "net" = "gross", tiebreakerMethod = "countback"): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const aToPar = mode === "net" ? a.netToPar : a.scoreToPar;
    const bToPar = mode === "net" ? b.netToPar : b.scoreToPar;

    if (aToPar === null && bToPar === null) return 0;
    if (aToPar === null) return 1;
    if (bToPar === null) return -1;
    if (aToPar !== bToPar) return aToPar - bToPar;

    // Apply tie-breaker
    if (tiebreakerMethod === "no_tiebreaker") return 0;

    if (tiebreakerMethod === "lower_handicap") return a.handicapIndex - b.handicapIndex;

    if (tiebreakerMethod === "multi_round_countback") {
      // Apply 9/6/3/1 countback ladder on current round first; if still tied, repeat for prior rounds
      const allRoundNums = [...new Set([...a.holeScores.map(h => h.round), ...b.holeScores.map(h => h.round)])].sort((x, y) => y - x);
      for (const rNum of allRoundNums) {
        const aH = a.holeScores.filter(h => h.round === rNum);
        const bH = b.holeScores.filter(h => h.round === rNum);
        if (aH.length < 18 || bH.length < 18) continue;
        const aL9 = aH.filter(h => h.hole >= 10).reduce((s, h) => s + h.toPar, 0);
        const bL9 = bH.filter(h => h.hole >= 10).reduce((s, h) => s + h.toPar, 0);
        if (aL9 !== bL9) return aL9 - bL9;
        const aL6 = aH.filter(h => h.hole >= 13).reduce((s, h) => s + h.toPar, 0);
        const bL6 = bH.filter(h => h.hole >= 13).reduce((s, h) => s + h.toPar, 0);
        if (aL6 !== bL6) return aL6 - bL6;
        const aL3 = aH.filter(h => h.hole >= 16).reduce((s, h) => s + h.toPar, 0);
        const bL3 = bH.filter(h => h.hole >= 16).reduce((s, h) => s + h.toPar, 0);
        if (aL3 !== bL3) return aL3 - bL3;
        const aL1 = aH.find(h => h.hole === 18)?.toPar ?? 0;
        const bL1 = bH.find(h => h.hole === 18)?.toPar ?? 0;
        if (aL1 !== bL1) return aL1 - bL1;
      }
      return 0;
    }

    if (tiebreakerMethod === "net_countback") {
      // Net countback: use actual net toPar per hole (gross toPar minus strokes received on that hole)
      const aRoundHoles = a.holeScores.filter(h => h.round === a.currentRound);
      const bRoundHoles = b.holeScores.filter(h => h.round === b.currentRound);
      if (aRoundHoles.length < 18 || bRoundHoles.length < 18) return b.holesCompleted - a.holesCompleted;
      const netHoleToPar = (holes: typeof aRoundHoles, ph: number) =>
        holes.map(h => ({ hole: h.hole, netToPar: h.toPar - (h.strokeIndex != null ? strokesOnHole(h.strokeIndex, ph) : 0) }));
      const aNet = netHoleToPar(aRoundHoles, a.playingHandicap);
      const bNet = netHoleToPar(bRoundHoles, b.playingHandicap);
      const aLast9 = aNet.filter(h => h.hole >= 10).reduce((s, h) => s + h.netToPar, 0);
      const bLast9 = bNet.filter(h => h.hole >= 10).reduce((s, h) => s + h.netToPar, 0);
      if (aLast9 !== bLast9) return aLast9 - bLast9;
      const aLast6 = aNet.filter(h => h.hole >= 13).reduce((s, h) => s + h.netToPar, 0);
      const bLast6 = bNet.filter(h => h.hole >= 13).reduce((s, h) => s + h.netToPar, 0);
      if (aLast6 !== bLast6) return aLast6 - bLast6;
      const aLast3 = aNet.filter(h => h.hole >= 16).reduce((s, h) => s + h.netToPar, 0);
      const bLast3 = bNet.filter(h => h.hole >= 16).reduce((s, h) => s + h.netToPar, 0);
      if (aLast3 !== bLast3) return aLast3 - bLast3;
      const aLast1 = aNet.find(h => h.hole === 18)?.netToPar ?? 0;
      const bLast1 = bNet.find(h => h.hole === 18)?.netToPar ?? 0;
      return aLast1 - bLast1;
    }

    // Default: standard countback on current round
    return countbackCurrentRound(a, b);
  });
}

function assignPositions(sorted: LeaderboardEntry[], mode: "gross" | "net" = "gross", tiebreakerMethod = "countback"): LeaderboardEntry[] {
  let currentPos = 1;
  const noTiebreaker = tiebreakerMethod === "no_tiebreaker";
  for (let i = 0; i < sorted.length; i++) {
    const toPar = mode === "net" ? sorted[i].netToPar : sorted[i].scoreToPar;
    const prevToPar = i > 0 ? (mode === "net" ? sorted[i - 1].netToPar : sorted[i - 1].scoreToPar) : undefined;
    const sameHoles = i > 0 && sorted[i].holesCompleted === sorted[i - 1].holesCompleted;

    // Only share positions (T-prefix) when no tiebreaker is configured;
    // for all other methods the sort already resolved the tie — give unique sequential ranks.
    if (noTiebreaker && i > 0 && toPar !== null && toPar === prevToPar && sameHoles) {
      sorted[i].position = sorted[i - 1].position;
      sorted[i].positionDisplay = `T${sorted[i - 1].position}`;
      if (!sorted[i - 1].positionDisplay.startsWith("T")) {
        sorted[i - 1].positionDisplay = `T${sorted[i - 1].position}`;
      }
    } else {
      sorted[i].position = currentPos;
      sorted[i].positionDisplay = String(currentPos);
    }
    currentPos++;
  }
  return sorted;
}

export async function computeLeaderboard(tournamentId: number) {
  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      courseId: tournamentsTable.courseId,
      rounds: tournamentsTable.rounds,
      handicapAllowance: tournamentsTable.handicapAllowance,
      cutLine: tournamentsTable.cutLine,
      cutAfterRound: tournamentsTable.cutAfterRound,
      cutPosition: tournamentsTable.cutPosition,
      tiebreakerMethod: tournamentsTable.tiebreakerMethod,
      leaderboardType: tournamentsTable.leaderboardType,
      stablefordPointsConfig: tournamentsTable.stablefordPointsConfig,
      maxScoreCap: tournamentsTable.maxScoreCap,
      organizationId: tournamentsTable.organizationId,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) return null;

  const players = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  // Batch-load profileImage for all players that have a linked app user account
  const userIds = players.map(p => p.userId).filter((id): id is number => id != null);
  const profileImageMap = new Map<number, string | null>();
  if (userIds.length > 0) {
    const userRows = await db.select({ id: appUsersTable.id, profileImage: appUsersTable.profileImage })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    for (const row of userRows) {
      profileImageMap.set(row.id, row.profileImage ?? null);
    }
  }

  let holeParMap: Map<number, number> = new Map();
  let holeStrokeIndexMap: Map<number, number | null> = new Map();
  let coursePar = 72;
  let courseSlope: number | null = null;
  let courseRating: number | null = null;

  if (tournament.courseId) {
    const [course] = await db
      .select({ slope: coursesTable.slope, rating: coursesTable.rating, par: coursesTable.par })
      .from(coursesTable)
      .where(eq(coursesTable.id, tournament.courseId));
    courseSlope = course?.slope ?? null;
    courseRating = course?.rating ? Number(course.rating) : null;

    const holes = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
    holeParMap = new Map(holes.map((h) => [h.holeNumber, h.par]));
    holeStrokeIndexMap = new Map(holes.map((h) => [h.holeNumber, h.handicap ?? null]));
    coursePar = holes.reduce((acc, h) => acc + h.par, 0) || (course?.par ?? 72);
  }

  // Per-round course par maps for multi-course championships
  // Key: roundNumber, Value: { parMap, siMap }
  const roundHoleParMaps = new Map<number, Map<number, number>>();
  const roundHoleStrokeIndexMaps = new Map<number, Map<number, number | null>>();

  const roundAssignments = await db.select({
    roundNumber: tournamentRoundsTable.roundNumber,
    courseId: tournamentRoundsTable.courseId,
  }).from(tournamentRoundsTable)
    .where(eq(tournamentRoundsTable.tournamentId, tournamentId));

  // Load hole details for each distinct round courseId (that differs from default)
  const distinctRoundCourseIds = [...new Set(roundAssignments
    .filter(r => r.courseId && r.courseId !== tournament.courseId)
    .map(r => r.courseId!))];

  const extraCourseHoles = new Map<number, typeof holeParMap>();
  const extraCourseSIs = new Map<number, typeof holeStrokeIndexMap>();
  // Extra course handicap stats (slope/rating/computed par) for per-round playing handicap
  const extraCourseStats = new Map<number, { slope: number | null; rating: number | null; par: number }>();
  for (const cId of distinctRoundCourseIds) {
    const [cRow] = await db.select({ slope: coursesTable.slope, rating: coursesTable.rating, par: coursesTable.par })
      .from(coursesTable).where(eq(coursesTable.id, cId));
    const ch = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, cId)).orderBy(holeDetailsTable.holeNumber);
    const parMap = new Map(ch.map(h => [h.holeNumber, h.par]));
    extraCourseHoles.set(cId, parMap);
    extraCourseSIs.set(cId, new Map(ch.map(h => [h.holeNumber, h.handicap ?? null])));
    const cPar = ch.reduce((a, h) => a + h.par, 0) || (cRow?.par ?? 72);
    extraCourseStats.set(cId, {
      slope: cRow?.slope ?? null,
      rating: cRow?.rating ? Number(cRow.rating) : null,
      par: cPar,
    });
  }

  // Build per-round course stats for computing per-round playing handicaps
  const roundCourseStatsMap = new Map<number, { slope: number | null; rating: number | null; par: number }>();
  for (const r of roundAssignments) {
    if (!r.courseId) continue;
    if (r.courseId === tournament.courseId) {
      roundCourseStatsMap.set(r.roundNumber, { slope: courseSlope, rating: courseRating, par: coursePar });
      continue;
    }
    const pm = extraCourseHoles.get(r.courseId);
    const sm = extraCourseSIs.get(r.courseId);
    const stats = extraCourseStats.get(r.courseId);
    if (pm) roundHoleParMaps.set(r.roundNumber, pm);
    if (sm) roundHoleStrokeIndexMaps.set(r.roundNumber, sm);
    if (stats) roundCourseStatsMap.set(r.roundNumber, stats);
  }

  const handicapAllowance = tournament.handicapAllowance ?? 100;

  // Load flight assignments from the dedicated flights table
  const playerFlightRows = await db
    .select({ playerId: playerFlightsTable.playerId, flightName: flightsTable.name, flightId: flightsTable.id })
    .from(playerFlightsTable)
    .innerJoin(flightsTable, eq(playerFlightsTable.flightId, flightsTable.id))
    .where(eq(flightsTable.tournamentId, tournamentId));

  const playerFlightMap = new Map<number, string[]>();
  for (const row of playerFlightRows) {
    if (!playerFlightMap.has(row.playerId)) playerFlightMap.set(row.playerId, []);
    playerFlightMap.get(row.playerId)!.push(row.flightName);
  }
  const hasFlightAssignments = playerFlightRows.length > 0;

  // Load all defined flights for this tournament (for ordering + per-flight tiebreaker)
  const definedFlights = await db
    .select({ name: flightsTable.name, tiebreakerMethod: flightsTable.tiebreakerMethod })
    .from(flightsTable)
    .where(eq(flightsTable.tournamentId, tournamentId))
    .orderBy(flightsTable.createdAt);

  const flightTiebreakerMap = new Map<string, string>();
  for (const f of definedFlights) {
    if (f.tiebreakerMethod) flightTiebreakerMap.set(f.name, f.tiebreakerMethod);
  }

  const totalRounds = tournament.rounds ?? 1;
  const cutLine = tournament.cutLine ?? null;
  const cutPosition = tournament.cutPosition ?? null;
  const stablefordConfig = tournament.stablefordPointsConfig as StablefordPointsConfig | null ?? null;
  const maxScoreCap = tournament.maxScoreCap ?? null;
  const format = tournament.format ?? "stroke_play";
  // maximum_score is stroke play with per-hole cap — NOT stableford display
  const isStablefordFormat = format === "stableford" || format === "team_stableford";
  const isParBogeyFormat = format === "par_bogey";
  const isMaxScoreFormat = format === "maximum_score";
  // Cut is applied after the explicitly configured round, or auto-detected
  const cutAfterRound = tournament.cutAfterRound ?? (totalRounds >= 4 ? 2 : totalRounds >= 2 ? 1 : null);
  const holeCount = holeParMap.size || 18;
  // Per-round hole count — used for completion detection when courses have different hole counts
  const roundHoleCountMap = new Map<number, number>();
  for (const [rNum, pm] of roundHoleParMaps.entries()) {
    if (pm.size > 0) roundHoleCountMap.set(rNum, pm.size);
  }

  const entries: LeaderboardEntry[] = await Promise.all(
    players.map(async (player) => {
      const allScores = await db
        .select()
        .from(scoresTable)
        .where(eq(scoresTable.playerId, player.id))
        .orderBy(scoresTable.round, scoresTable.holeNumber);

      const handicapIndex = effectiveHandicapIndex(player.handicapIndex, player.handicapOverride);
      // Tournament-level playing handicap (primary course / fallback)
      const playingHandicap = computePlayingHandicap(handicapIndex, courseSlope, courseRating, coursePar, handicapAllowance);

      // Per-round playing handicap — uses each round's course slope/rating/par when different
      const roundPlayingHandicaps = new Map<number, number>();
      for (let r = 1; r <= totalRounds; r++) {
        const rStats = roundCourseStatsMap.get(r);
        roundPlayingHandicaps.set(r, rStats
          ? computePlayingHandicap(handicapIndex, rStats.slope, rStats.rating, rStats.par, handicapAllowance)
          : playingHandicap);
      }

      // Group by round
      const byRound = new Map<number, typeof allScores>();
      for (const s of allScores) {
        if (!byRound.has(s.round)) byRound.set(s.round, []);
        byRound.get(s.round)!.push(s);
      }

      // Build per-round score summaries
      const roundScores: RoundScore[] = [];
      let cumulativeGross = 0;
      let cumulativePar = 0;
      let cumulativeStableford = 0;
      let cumulativeNet = 0;
      let roundsWithData = 0;

      for (let r = 1; r <= totalRounds; r++) {
        const rScores = byRound.get(r);
        if (!rScores || rScores.length === 0) continue;
        const rParMap = roundHoleParMaps.get(r) ?? holeParMap;
        const rSiMap = roundHoleStrokeIndexMaps.get(r) ?? holeStrokeIndexMap;
        const rPh = roundPlayingHandicaps.get(r) ?? playingHandicap;
        const rGross = rScores.reduce((acc, s) => {
          const holePar = rParMap.get(s.holeNumber) ?? 4;
          const effectiveStrokes = isMaxScoreFormat && maxScoreCap !== null
            ? Math.min(s.strokes, holePar + maxScoreCap)
            : s.strokes;
          return acc + effectiveStrokes;
        }, 0);
        const rPar = rScores.reduce((acc, s) => acc + (rParMap.get(s.holeNumber) ?? 4), 0);
        const rStableford = rScores.reduce((acc, s) => {
          const si = rSiMap.get(s.holeNumber) ?? null;
          const holePar = rParMap.get(s.holeNumber) ?? 4;
          const effectiveStrokes = isMaxScoreFormat && maxScoreCap !== null
            ? Math.min(s.strokes, holePar + maxScoreCap)
            : s.strokes;
          return acc + stablefordPointsForHole(effectiveStrokes, holePar, si, rPh, stablefordConfig);
        }, 0);
        const rHoleCount = roundHoleCountMap.get(r) ?? holeCount;
        const rComplete = rScores.length >= rHoleCount;
        // Net: for complete rounds deduct full playing handicap;
        // for in-progress rounds deduct only strokes received on holes played (hole-accurate)
        const rHandicapDeduction = rComplete
          ? rPh
          : rScores.reduce((acc, s) => acc + strokesOnHole(rSiMap.get(s.holeNumber) ?? null, rPh), 0);
        const rNetScore = rGross - rHandicapDeduction;
        roundScores.push({
          round: r,
          grossScore: rGross,
          scoreToPar: rGross - rPar,
          netScore: rNetScore,
          stablefordPoints: rStableford,
          holesPlayed: rScores.length,
          isComplete: rComplete,
        });
        cumulativeGross += rGross;
        cumulativePar += rPar;
        cumulativeStableford += rStableford;
        cumulativeNet += rNetScore;
        roundsWithData++;
      }

      // Determine current round from player field (or last round with scores)
      const currentRoundNum = player.currentRound ?? (roundsWithData > 0 ? Math.max(...Array.from(byRound.keys())) : 1);
      const currentRoundScores = byRound.get(currentRoundNum) ?? [];
      const currentRoundHolesPlayed = currentRoundScores.length;

      // Build holeScores from all rounds (with round tag), using per-round par maps for multi-course events
      const holeScores = allScores.map((s) => {
        const hParMap = roundHoleParMaps.get(s.round) ?? holeParMap;
        const hSiMap = roundHoleStrokeIndexMaps.get(s.round) ?? holeStrokeIndexMap;
        const hPh = roundPlayingHandicaps.get(s.round) ?? playingHandicap;
        const par = hParMap.get(s.holeNumber) ?? 4;
        const si = hSiMap.get(s.holeNumber) ?? null;
        // Apply maximum score cap when format requires it
        const effectiveStrokes = isMaxScoreFormat && maxScoreCap !== null
          ? Math.min(s.strokes, par + maxScoreCap)
          : s.strokes;
        // Exact per-hole handicap strokes: 1 stroke if SI <= playingHandicap, +1 if SI <= playingHandicap-18
        const handicapStrokesOnHole = (si != null && hPh > 0)
          ? (si <= hPh ? 1 : 0) + (si <= hPh - 18 ? 1 : 0)
          : 0;
        // Par/Bogey: compare net score vs par (net target = par + handicap strokes received)
        const parBogeyResult: "W" | "L" | "H" | null = isParBogeyFormat
          ? (effectiveStrokes < par + handicapStrokesOnHole ? "W"
            : effectiveStrokes === par + handicapStrokesOnHole ? "H" : "L")
          : null;
        return {
          hole: s.holeNumber,
          round: s.round,
          strokes: effectiveStrokes,
          rawStrokes: s.strokes,
          par,
          toPar: effectiveStrokes - par,
          netToPar: effectiveStrokes - handicapStrokesOnHole - par,
          strokeIndex: si,
          stablefordPoints: stablefordPointsForHole(effectiveStrokes, par, si, hPh, stablefordConfig),
          parBogeyResult,
          isVerified: s.isVerified,
          putts: s.putts,
          fairwayHit: s.fairwayHit,
          girHit: s.girHit,
        };
      });

      const grossScore = roundsWithData > 0 ? cumulativeGross : null;
      const netScore = roundsWithData > 0 ? cumulativeNet : null;
      const stablefordPoints = roundsWithData > 0 ? cumulativeStableford : null;
      const scoreToPar = grossScore !== null ? cumulativeGross - cumulativePar : null;
      const netToPar = netScore !== null ? netScore - cumulativePar : null;

      // Cut line: madeCut = null if no cut, true if made it, false if missed
      let madeCut: boolean | null = null;
      if (cutLine !== null && cutAfterRound !== null) {
        const roundsPlayedForCut = roundScores.filter(rs => rs.round <= cutAfterRound && rs.isComplete).length;
        if (roundsPlayedForCut >= cutAfterRound) {
          // Use accumulated per-round scoreToPar so multi-course events get the
          // correct par for each round rather than a fixed coursePar * rounds
          const cutToPar = roundScores
            .filter(rs => rs.round <= cutAfterRound)
            .reduce((a, rs) => a + rs.scoreToPar, 0);
          madeCut = cutToPar <= cutLine;
        }
      }
      // Task #1004 — persisted cut from cutHandler always wins. If an admin
      // ran applyCut and the player was marked, force missed-cut so the
      // leaderboard segregates them even when scores are later edited.
      if (player.cutAt != null) madeCut = false;

      // Thru display: multi-round aware; use per-round hole count for current round
      const currentRoundHoleCount = roundHoleCountMap.get(currentRoundNum) ?? holeCount;
      let thru = "-";
      if (roundsWithData > 0) {
        const completedRounds = roundScores.filter(rs => rs.isComplete).length;
        if (completedRounds === totalRounds) {
          thru = totalRounds > 1 ? `R${totalRounds} F` : "F";
        } else if (currentRoundHolesPlayed === 0 && completedRounds > 0) {
          thru = `R${completedRounds} F`;
        } else if (currentRoundHolesPlayed >= currentRoundHoleCount) {
          thru = `R${currentRoundNum} F`;
        } else if (currentRoundHolesPlayed > 0) {
          thru = totalRounds > 1 ? `R${currentRoundNum} T${currentRoundHolesPlayed}` : String(currentRoundHolesPlayed);
        }
      }

      const fairwaysHit = holeScores.filter(h => h.fairwayHit === true).length;
      const fairwayOpportunities = holeScores.filter(h => h.fairwayHit !== null).length;
      const girHit = holeScores.filter(h => h.girHit === true).length;
      const totalPutts = holeScores.reduce((acc, h) => acc + (h.putts ?? 0), 0);
      const holesPlayed = allScores.length;
      const eagles = holeScores.filter(h => h.toPar <= -2).length;
      const birdies = holeScores.filter(h => h.toPar === -1).length;
      const pars = holeScores.filter(h => h.toPar === 0).length;
      const bogeys = holeScores.filter(h => h.toPar === 1).length;
      const doublePlus = holeScores.filter(h => h.toPar >= 2).length;

      const playerFlights = hasFlightAssignments
        ? (playerFlightMap.get(player.id) ?? [])
        : (player.flight ? [player.flight] : []);

      // Par/Bogey running score: W=+1, L=-1, H=0
      const parBogeyScore: number | null = isParBogeyFormat && holeScores.length > 0
        ? holeScores.reduce((acc, h) => acc + (h.parBogeyResult === "W" ? 1 : h.parBogeyResult === "L" ? -1 : 0), 0)
        : null;

      return {
        position: 0,
        positionDisplay: "",
        playerId: player.id,
        // Linked portal user account id (when this tournament player is connected
        // to an app user). Surfaced so leaderboard rows can render a Follow button
        // for the underlying member account (Task #1420).
        userId: player.userId ?? null,
        playerName: `${player.firstName} ${player.lastName}`,
        profileImage: player.userId ? (profileImageMap.get(player.userId) ?? null) : null,
        flights: playerFlights,
        handicapIndex,
        playingHandicap,
        grossScore,
        netScore,
        scoreToPar,
        netToPar,
        stablefordPoints,
        parBogeyScore,
        holesCompleted: holesPlayed,
        currentHole: player.currentHole ?? null,
        holeScores,
        thru,
        currentRound: currentRoundNum,
        roundScores,
        madeCut,
        checkedIn: player.checkedIn,
        dns: player.dns ?? false,
        teeBox: player.teeBox ?? null,
        stats: {
          eagles, birdies, pars, bogeys, doublePlus,
          fairwaysHit, fairwayOpportunities,
          girHit, totalPutts,
          avgPutts: holesPlayed > 0 ? +(totalPutts / holesPlayed).toFixed(2) : null,
        },
        isVerified: holeScores.length > 0 && holeScores.every(h => h.isVerified),
        teamId: null as number | null,
        teamName: null as string | null,
      };
    }),
  );

  // Mark DNS players with special position display and push to bottom
  for (const e of entries) {
    if (e.dns) {
      e.position = 9999;
      e.positionDisplay = "DNS";
    }
  }

  const tournamentTiebreaker = tournament.tiebreakerMethod ?? "countback";
  const leaderboardType = tournament.leaderboardType ?? "both";

  // ── Position-based cut logic (cutPosition) ──────────────────────────────
  // Runs after all entries are scored. Applies before sorting so madeCut is set correctly.
  if (cutAfterRound !== null && cutPosition) {
    // Determine the cut size from cutPosition string: "top50", "top50_ties", "top65_ties", etc.
    const posMatch = cutPosition.match(/^top(\d+)(_ties)?$/);
    if (posMatch) {
      const cutSize = parseInt(posMatch[1], 10);
      const includeTies = posMatch[2] === "_ties";
      // Build cut scores per player using only rounds UP TO cutAfterRound
      const cutScores = new Map<number, number>();
      for (const e of entries) {
        if (e.dns) continue;
        const cutRoundScores = e.roundScores.filter(r => r.round <= cutAfterRound);
        const completedCutRounds = cutRoundScores.filter(r => r.isComplete).length;
        if (completedCutRounds >= cutAfterRound) {
          let cutScore: number;
          if (isStablefordFormat) {
            // Sum stableford points through cutAfterRound (negate: lower sort value = better)
            cutScore = -(cutRoundScores.reduce((a, r) => a + (r.stablefordPoints ?? 0), 0));
          } else if (isParBogeyFormat) {
            // Sum par/bogey W/L for holes in rounds ≤ cutAfterRound
            cutScore = -(e.holeScores
              .filter(h => h.round <= cutAfterRound)
              .reduce((a, h) => a + (h.parBogeyResult === "W" ? 1 : h.parBogeyResult === "L" ? -1 : 0), 0));
          } else {
            // Stroke play / max_score: sum scoreToPar through cutAfterRound
            cutScore = cutRoundScores.reduce((a, r) => a + r.scoreToPar, 0);
          }
          cutScores.set(e.playerId, cutScore);
        }
      }
      // Sort cut scores ascending (lower score value = better position = more likely to make cut)
      const sortedCutScores = [...cutScores.entries()].sort((a, b) => a[1] - b[1]);
      const cutThresholdScore = sortedCutScores[cutSize - 1]?.[1] ?? null;
      if (cutThresholdScore !== null) {
        for (const e of entries) {
          if (e.dns) { e.madeCut = false; continue; }
          const cs = cutScores.get(e.playerId);
          if (cs === undefined) { e.madeCut = null; continue; }
          if (includeTies) {
            // All players at or better than the cut threshold make it
            e.madeCut = cs <= cutThresholdScore;
          } else {
            // Exactly cutSize players make it — use rank in sorted order
            const rank = sortedCutScores.findIndex(([pid]) => pid === e.playerId);
            e.madeCut = rank >= 0 && rank < cutSize;
          }
        }
      }
    }
  }

  // Persisted cut decision (players.cutAt set by cutHandler) is authoritative
  // and must override any recomputed madeCut value — including the position-
  // based cut block above. Once a tournament officially cuts a player they
  // stay cut even if the recomputed math would put them back inside the line.
  const persistedCutPlayerIds = new Set(
    players.filter(p => p.cutAt != null).map(p => p.id),
  );
  if (persistedCutPlayerIds.size > 0) {
    for (const e of entries) {
      if (persistedCutPlayerIds.has(e.playerId)) e.madeCut = false;
    }
  }

  // ── Sort helpers for stableford / par-bogey formats (higher = better) ──
  function sortByStablefordDesc(list: LeaderboardEntry[]): LeaderboardEntry[] {
    return [...list].sort((a, b) => {
      const aP = a.stablefordPoints;
      const bP = b.stablefordPoints;
      if (aP === null && bP === null) return 0;
      if (aP === null) return 1;
      if (bP === null) return -1;
      if (bP !== aP) return bP - aP;
      return b.holesCompleted - a.holesCompleted;
    });
  }
  function sortByParBogeyDesc(list: LeaderboardEntry[]): LeaderboardEntry[] {
    return [...list].sort((a, b) => {
      const aP = a.parBogeyScore;
      const bP = b.parBogeyScore;
      if (aP === null && bP === null) return 0;
      if (aP === null) return 1;
      if (bP === null) return -1;
      if (bP !== aP) return bP - aP;
      return b.holesCompleted - a.holesCompleted;
    });
  }
  function assignStablefordPositions(sorted: LeaderboardEntry[], useParBogey = false): LeaderboardEntry[] {
    let pos = 1;
    for (let i = 0; i < sorted.length; i++) {
      const score = useParBogey ? sorted[i].parBogeyScore : sorted[i].stablefordPoints;
      const prevScore = i > 0 ? (useParBogey ? sorted[i - 1].parBogeyScore : sorted[i - 1].stablefordPoints) : undefined;
      if (i > 0 && score !== null && score === prevScore && sorted[i].holesCompleted === sorted[i - 1].holesCompleted) {
        sorted[i].position = sorted[i - 1].position;
        sorted[i].positionDisplay = `T${sorted[i - 1].position}`;
        if (!sorted[i - 1].positionDisplay.startsWith("T")) {
          sorted[i - 1].positionDisplay = `T${sorted[i - 1].position}`;
        }
      } else {
        sorted[i].position = pos;
        sorted[i].positionDisplay = String(pos);
      }
      pos++;
    }
    return sorted;
  }

  // Overall gross leaderboard: active players sorted by score-to-par, DNS at bottom
  const dnsEntries = entries.filter(e => e.dns);
  const activeEntries = entries.filter(e => !e.dns);
  const withScores = activeEntries.filter(e => e.grossScore !== null || e.stablefordPoints !== null || e.parBogeyScore !== null);
  const noScores = activeEntries.filter(e => e.grossScore === null && e.stablefordPoints === null && e.parBogeyScore === null);
  let overallEntries: LeaderboardEntry[];
  if (isStablefordFormat) {
    overallEntries = assignStablefordPositions(sortByStablefordDesc(withScores), false).concat(noScores).concat(dnsEntries);
  } else if (isParBogeyFormat) {
    overallEntries = assignStablefordPositions(sortByParBogeyDesc(withScores), true).concat(noScores).concat(dnsEntries);
  } else {
    const overallSorted = sortByToPar(withScores, "gross", tournamentTiebreaker);
    overallEntries = assignPositions(overallSorted, "gross", tournamentTiebreaker).concat(noScores).concat(dnsEntries);
  }

  // Compute cutLineIndex: the 0-based index in overallEntries after which the cut falls
  let cutLineIndex: number | null = null;
  if (cutAfterRound !== null) {
    const missedCutIdx = overallEntries.findIndex(e => e.madeCut === false);
    if (missedCutIdx > 0) cutLineIndex = missedCutIdx - 1;
  }

  // Net leaderboard sorted by net-to-par; DNS also at bottom
  const activeCopies = activeEntries.map(e => ({ ...e }));
  const dnsCopies = dnsEntries.map(e => ({ ...e }));
  const withNetScores = activeCopies.filter(e => e.netScore !== null);
  const noNetScores = activeCopies.filter(e => e.netScore === null);
  const netTiebreaker = tournamentTiebreaker === "net_countback" ? "net_countback" : tournamentTiebreaker;
  const netSorted = sortByToPar(withNetScores, "net", netTiebreaker);
  const netEntries = assignPositions(netSorted, "net", netTiebreaker).concat(noNetScores).concat(dnsCopies);

  // Stableford leaderboard sorted by stableford points descending (higher = better)
  const sfActiveCopies = activeEntries.map(e => ({ ...e }));
  const sfDnsCopies = dnsEntries.map(e => ({ ...e }));
  const withStableford = sfActiveCopies.filter(e => e.stablefordPoints !== null);
  const noStableford = sfActiveCopies.filter(e => e.stablefordPoints === null);
  const sfSorted = [...withStableford].sort((a, b) => (b.stablefordPoints ?? 0) - (a.stablefordPoints ?? 0));
  let sfPos = 1;
  for (let i = 0; i < sfSorted.length; i++) {
    if (i > 0 && sfSorted[i].stablefordPoints === sfSorted[i - 1].stablefordPoints) {
      sfSorted[i].position = sfSorted[i - 1].position;
      sfSorted[i].positionDisplay = `T${sfSorted[i - 1].position}`;
      if (!sfSorted[i - 1].positionDisplay.startsWith("T")) {
        sfSorted[i - 1].positionDisplay = `T${sfSorted[i - 1].position}`;
      }
    } else {
      sfSorted[i].position = sfPos;
      sfSorted[i].positionDisplay = String(sfPos);
    }
    sfPos++;
  }
  const stablefordEntries = sfSorted.concat(noStableford).concat(sfDnsCopies);

  // Derive available views from format + leaderboardType
  const stablefordFormats = ["stableford", "modified_stableford", "alliance", "skins"];
  const isStablefordView = stablefordFormats.includes(tournament.format ?? "");
  const availableViews: string[] = [];
  if (leaderboardType !== "net") availableViews.push("gross");
  if (leaderboardType !== "gross") availableViews.push("net");
  if (isStablefordView || (leaderboardType as string) === "stableford") availableViews.push("stableford");
  if (availableViews.length === 0) availableViews.push("gross");

  // Group by flight — a player can appear in multiple flights
  const byFlight: Record<string, LeaderboardEntry[]> = {};
  const flights: string[] = [];

  // Use defined flights order if available, otherwise infer from player data
  const flightNames: string[] = definedFlights.length > 0
    ? definedFlights.map(f => f.name)
    : [...new Set(overallEntries.flatMap(e => e.flights.length > 0 ? e.flights : ["Overall"]))];

  for (const flightName of flightNames) {
    const flightEntries = overallEntries
      .filter(e => {
        if (e.flights.length === 0) return flightName === "Overall";
        return e.flights.includes(flightName);
      })
      .map(e => ({ ...e }));

    const flightDns = flightEntries.filter(e => e.dns);
    const flightActive = flightEntries.filter(e => !e.dns);
    const flightWithScores = flightActive.filter(e => e.grossScore !== null);
    const flightNoScores = flightActive.filter(e => e.grossScore === null);
    // Per-flight tiebreaker override falls back to tournament-level
    const flightTiebreaker = flightTiebreakerMap.get(flightName) ?? tournamentTiebreaker;
    const flightSorted = sortByToPar(flightWithScores, "gross", flightTiebreaker);
    byFlight[flightName] = assignPositions(flightSorted, "gross", flightTiebreaker).concat(flightNoScores).concat(flightDns);
    flights.push(flightName);
  }

  // If no flight names at all, create "Overall" group
  if (flights.length === 0) {
    byFlight["Overall"] = overallEntries.map(e => ({ ...e }));
    flights.push("Overall");
  }

  // ── Team entity aggregation ───────────────────────────────────────────
  const teamFormats = ["scramble", "texas_scramble", "best_ball", "shamble", "four_ball", "foursomes", "alliance", "stroke_play", "team_stableford"];
  const isTeamFormat = teamFormats.includes(tournament.format ?? "");

  type TeamEntry = {
    position: number; positionDisplay: string;
    teamId: number; teamName: string; teamColour: string | null;
    grossScore: number | null; netScore: number | null;
    scoreToPar: number | null; netToPar: number | null;
    stablefordPoints: number | null; holesCompleted: number;
    members: Array<{ playerId: number; userId: number | null; playerName: string; handicapIndex: number; grossScore: number | null }>;
  };

  let teamEntries: TeamEntry[] = [];
  let teamCount = 0;

  if (isTeamFormat) {
    const dbTeams = await db.select().from(eventTeamsTable).where(eq(eventTeamsTable.tournamentId, tournamentId));
    teamCount = dbTeams.length;
    if (dbTeams.length > 0) {
      const teamIds = dbTeams.map(t => t.id);
      const dbMembers = await db.select().from(eventTeamMembersTable).where(inArray(eventTeamMembersTable.teamId, teamIds));

      // Build a map from playerId → teamId
      const playerToTeam = new Map<number, number>();
      for (const m of dbMembers) {
        if (m.playerId != null) playerToTeam.set(m.playerId, m.teamId);
      }

      // Annotate all entries with teamId/teamName
      const teamMap = new Map(dbTeams.map(t => [t.id, t]));
      for (const e of [...overallEntries, ...netEntries, ...Object.values(byFlight).flat()]) {
        const tid = playerToTeam.get(e.playerId);
        if (tid != null) {
          const t = teamMap.get(tid);
          e.teamId = tid;
          e.teamName = t?.name ?? null;
        }
      }

      // Build team entries — aggregate by team
      for (const team of dbTeams) {
        const memberEntries = overallEntries.filter(e => playerToTeam.get(e.playerId) === team.id);
        if (memberEntries.length === 0) continue;

        let teamGross: number | null = null;
        let teamNet: number | null = null;
        let teamSTP: number | null = null;
        let teamNTP: number | null = null;
        let teamStableford: number | null = null;
        const maxHoles = Math.max(...memberEntries.map(e => e.holesCompleted));
        const fmt = tournament.format as string;

        if (fmt === "scramble" || fmt === "texas_scramble") {
          // Scramble: entire team plays one ball. Per task spec, team score = avg gross of all members.
          // Members all record the same score; avg handles minor data entry variance without bias.
          const scored = memberEntries.filter(e => e.grossScore !== null);
          if (scored.length > 0) {
            const n = scored.length;
            teamGross = Math.round(scored.reduce((s, e) => s + e.grossScore!, 0) / n);
            teamNet = scored.every(e => e.netScore !== null)
              ? Math.round(scored.reduce((s, e) => s + e.netScore!, 0) / n)
              : null;
            teamSTP = Math.round(scored.reduce((s, e) => s + (e.scoreToPar ?? 0), 0) / n);
            teamNTP = scored.every(e => e.netToPar !== null)
              ? Math.round(scored.reduce((s, e) => s + (e.netToPar ?? 0), 0) / n)
              : null;
            teamStableford = scored.every(e => e.stablefordPoints !== null)
              ? Math.round(scored.reduce((s, e) => s + (e.stablefordPoints ?? 0), 0) / n)
              : null;
          }
        } else if (fmt === "best_ball" || fmt === "four_ball") {
          // Best Ball / Four Ball: best net per hole (exact netToPar), keyed by (round, hole).
          // Using composite (round, hole) keys ensures multi-round totals are correct.
          const rhPairs = [...new Map(
            memberEntries.flatMap(e => e.holeScores.map(h => [`${h.round}:${h.hole}`, { round: h.round, hole: h.hole }]))
          ).values()];
          let tGross = 0, tSTP = 0, tNTP = 0, tStbl = 0;
          for (const { round, hole } of rhPairs) {
            const hs = memberEntries.flatMap(e => e.holeScores.filter(h => h.round === round && h.hole === hole));
            if (hs.length > 0) {
              const best = hs.reduce((b, h) => h.netToPar < b.netToPar ? h : b);
              tGross += best.strokes; tSTP += best.toPar;
              tStbl += best.stablefordPoints; tNTP += best.netToPar;
            }
          }
          if (rhPairs.length > 0) {
            teamGross = tGross; teamSTP = tSTP;
            teamNet = (tGross - tSTP) + tNTP; teamNTP = tNTP;
            teamStableford = tStbl;
          }
        } else if (fmt === "alliance") {
          // Alliance: sum the best 2 stableford scores per (round, hole).
          const rhPairs = [...new Map(
            memberEntries.flatMap(e => e.holeScores.map(h => [`${h.round}:${h.hole}`, { round: h.round, hole: h.hole }]))
          ).values()];
          const countPerHole = 2;
          let tGross = 0, tSTP = 0, tNTP = 0, tStbl = 0;
          for (const { round, hole } of rhPairs) {
            const hs = memberEntries
              .flatMap(e => e.holeScores.filter(h => h.round === round && h.hole === hole))
              .sort((a, b) => b.stablefordPoints - a.stablefordPoints);
            const best = hs.slice(0, countPerHole);
            if (best.length > 0) {
              tGross += best.reduce((s, h) => s + h.strokes, 0);
              tSTP += best.reduce((s, h) => s + h.toPar, 0);
              const holeStbl = best.reduce((s, h) => s + h.stablefordPoints, 0);
              tStbl += holeStbl;
              // netToPar for alliance: best-2 stableford → netToPar = countPerHole*2 - holeStbl
              tNTP += (countPerHole * 2 - holeStbl);
            }
          }
          if (rhPairs.length > 0) {
            teamGross = tGross; teamSTP = tSTP;
            teamNet = (tGross - tSTP) + tNTP; teamNTP = tNTP;
            teamStableford = tStbl;
          }
        } else if (fmt === "shamble") {
          // Shamble: best net per (round, hole) using exact netToPar.
          const rhPairs = [...new Map(
            memberEntries.flatMap(e => e.holeScores.map(h => [`${h.round}:${h.hole}`, { round: h.round, hole: h.hole }]))
          ).values()];
          let tGross = 0, tSTP = 0, tNTP = 0, tStbl = 0;
          for (const { round, hole } of rhPairs) {
            const hs = memberEntries.flatMap(e => e.holeScores.filter(h => h.round === round && h.hole === hole));
            if (hs.length > 0) {
              const best = hs.reduce((b, h) => h.netToPar < b.netToPar ? h : b);
              tGross += best.strokes; tSTP += best.toPar;
              tStbl += best.stablefordPoints; tNTP += best.netToPar;
            }
          }
          if (rhPairs.length > 0) {
            teamGross = tGross; teamSTP = tSTP;
            teamNet = (tGross - tSTP) + tNTP; teamNTP = tNTP;
            teamStableford = tStbl;
          }
        } else if (fmt === "stroke_play") {
          // Stroke Play team: lowest net per (round, hole) counts.
          // Exact netToPar = gross - handicapStrokesOnHole - par (computed at holeScores build time).
          const rhPairs = [...new Map(
            memberEntries.flatMap(e => e.holeScores.map(h => [`${h.round}:${h.hole}`, { round: h.round, hole: h.hole }]))
          ).values()];
          let tGross = 0, tSTP = 0, tNTP = 0, tStbl = 0;
          for (const { round, hole } of rhPairs) {
            const hs = memberEntries.flatMap(e => e.holeScores.filter(h => h.round === round && h.hole === hole));
            if (hs.length > 0) {
              const best = hs.reduce((b, h) => h.netToPar < b.netToPar ? h : b);
              tGross += best.strokes; tSTP += best.toPar;
              tStbl += best.stablefordPoints; tNTP += best.netToPar;
            }
          }
          if (rhPairs.length > 0) {
            teamGross = tGross; teamSTP = tSTP;
            teamNet = (tGross - tSTP) + tNTP; teamNTP = tNTP;
            teamStableford = tStbl;
          }
        } else if (fmt === "team_stableford") {
          // Team Stableford: sum stableford points for best N-of-M players per (round, hole).
          // Uses stablefordPointsConfig.bestOf if configured; defaults to floor(teamSize/2).
          const configBestOf = (stablefordConfig as { bestOf?: number } | null)?.bestOf;
          const countPerHole = configBestOf ?? (Math.max(1, Math.floor(memberEntries.length / 2)) || 2);
          const rhPairs = [...new Map(
            memberEntries.flatMap(e => e.holeScores.map(h => [`${h.round}:${h.hole}`, { round: h.round, hole: h.hole }]))
          ).values()];
          let tGross = 0, tSTP = 0, tNTP = 0, tStbl = 0;
          for (const { round, hole } of rhPairs) {
            const hs = memberEntries
              .flatMap(e => e.holeScores.filter(h => h.round === round && h.hole === hole))
              .sort((a, b) => b.stablefordPoints - a.stablefordPoints);
            const best = hs.slice(0, countPerHole);
            if (best.length > 0) {
              tGross += best.reduce((s, h) => s + h.strokes, 0);
              tSTP += best.reduce((s, h) => s + h.toPar, 0);
              tStbl += best.reduce((s, h) => s + h.stablefordPoints, 0);
              tNTP += best.reduce((s, h) => s + h.netToPar, 0);
            }
          }
          if (rhPairs.length > 0) {
            teamGross = tGross; teamSTP = tSTP;
            teamNet = (tGross - tSTP) + tNTP; teamNTP = tNTP;
            teamStableford = tStbl;
          }
        } else {
          // Foursomes / other: sum all members' scores (alternating shots — one team score)
          const scored = memberEntries.filter(e => e.grossScore !== null);
          if (scored.length > 0) {
            teamGross = scored.reduce((s, e) => s + e.grossScore!, 0);
            teamNet = scored.every(e => e.netScore !== null) ? scored.reduce((s, e) => s + e.netScore!, 0) : null;
            teamSTP = scored.reduce((s, e) => s + (e.scoreToPar ?? 0), 0);
            teamNTP = scored.every(e => e.netToPar !== null) ? scored.reduce((s, e) => s + e.netToPar!, 0) : null;
            teamStableford = scored.reduce((s, e) => s + (e.stablefordPoints ?? 0), 0);
          }
        }

        teamEntries.push({
          position: 0, positionDisplay: "",
          teamId: team.id, teamName: team.name, teamColour: team.colour ?? null,
          grossScore: teamGross, netScore: teamNet,
          scoreToPar: teamSTP, netToPar: teamNTP,
          stablefordPoints: teamStableford, holesCompleted: maxHoles,
          // Surface the linked appUsersTable.id so the mobile team-standings
          // expanded row can navigate into the public profile viewer for each
          // teammate (Task #1791 — parity with the singles leaderboard rows).
          members: memberEntries.map(e => ({ playerId: e.playerId, userId: e.userId ?? null, playerName: e.playerName, handicapIndex: e.handicapIndex, grossScore: e.grossScore })),
        });
      }

      // Sort and assign positions for team entries.
      // Net-based formats rank by netToPar ascending; gross/scramble by scoreToPar ascending.
      // team_stableford ranks by stablefordPoints descending (higher = better).
      // stroke_play team format ranks by lowest net (stroke play "lowest net" per task spec).
      const netBased = ["best_ball", "four_ball", "alliance", "shamble", "stroke_play"].includes(tournament.format ?? "");
      const isTeamStableford = tournament.format === "team_stableford";
      const scoredTeams = teamEntries.filter(t => t.grossScore !== null || t.stablefordPoints !== null);
      const unscoredTeams = teamEntries.filter(t => t.grossScore === null && t.stablefordPoints === null);
      if (isTeamStableford) {
        scoredTeams.sort((a, b) => (b.stablefordPoints ?? 0) - (a.stablefordPoints ?? 0));
      } else if (netBased) {
        scoredTeams.sort((a, b) => (a.netToPar ?? a.scoreToPar ?? 0) - (b.netToPar ?? b.scoreToPar ?? 0));
      } else {
        scoredTeams.sort((a, b) => (a.scoreToPar ?? 0) - (b.scoreToPar ?? 0));
      }
      let tPos = 1;
      for (let i = 0; i < scoredTeams.length; i++) {
        scoredTeams[i].position = tPos;
        scoredTeams[i].positionDisplay = String(tPos++);
      }
      teamEntries = [...scoredTeams, ...unscoredTeams];
    }
  }

  return {
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    format: tournament.format,
    maxScoreCap,
    cutAfterRound,
    coursePar,
    rounds: tournament.rounds ?? 1,
    cutLine,
    cutLineIndex,
    tiebreakerMethod: tournamentTiebreaker,
    leaderboardType,
    availableViews,
    lastUpdated: new Date().toISOString(),
    entries: overallEntries,
    netEntries,
    stablefordEntries,
    byFlight,
    flights,
    isTeamFormat,
    teamCount,
    teamEntries,
    organizationId: tournament.organizationId ?? null,
  };
}

// ─── Pace of Play SSE ────────────────────────────────────────────────────────
const paceClients = new Map<number, Set<Response>>();

export function addPaceClient(tournamentId: number, res: Response): void {
  if (!paceClients.has(tournamentId)) paceClients.set(tournamentId, new Set());
  paceClients.get(tournamentId)!.add(res);
}

export function removePaceClient(tournamentId: number, res: Response): void {
  paceClients.get(tournamentId)?.delete(res);
}

export function notifyPaceUpdate(tournamentId: number, data: unknown): void {
  const set = paceClients.get(tournamentId);
  if (!set) return;
  const msg = `data: ${JSON.stringify({ type: "pace_update", data })}\n\n`;
  for (const client of set) {
    try { client.write(msg); } catch { set.delete(client); }
  }
}

// ─── Fantasy leaderboard SSE ─────────────────────────────────────────────────
const fantasyClients = new Map<number, Set<Response>>();

export function addFantasyClient(fantasyLeagueId: number, res: Response): void {
  if (!fantasyClients.has(fantasyLeagueId)) fantasyClients.set(fantasyLeagueId, new Set());
  fantasyClients.get(fantasyLeagueId)!.add(res);
}

export function removeFantasyClient(fantasyLeagueId: number, res: Response): void {
  fantasyClients.get(fantasyLeagueId)?.delete(res);
}

export function notifyFantasyUpdate(fantasyLeagueId: number, data: unknown): void {
  const set = fantasyClients.get(fantasyLeagueId);
  if (!set) return;
  const msg = `data: ${JSON.stringify({ type: "fantasy_update", data })}\n\n`;
  for (const client of set) {
    try { client.write(msg); } catch { set.delete(client); }
  }
}
