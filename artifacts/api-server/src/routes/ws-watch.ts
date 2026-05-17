/**
 * /ws/watch — WebSocket endpoint for Apple Watch & Wear OS companion apps.
 *
 * Authentication: Bearer <watchToken> sent as the first message after connect.
 * The server verifies the HMAC-signed token before sending any data.
 *
 * Protocol (all messages are JSON):
 *   Client → Server:
 *     { type: "auth",      token: string }
 *     { type: "subscribe", tournamentId: number, round: number, lat?: number, lng?: number }
 *     { type: "position",  lat: number, lng: number }
 *     { type: "score",     holeNumber: number, strokes: number, lat?: number, lng?: number }
 *     { type: "shot",      holeNumber: number, shotNumber: number, club?: string, lat: number, lng: number, distanceToPin?: number }
 *     { type: "ping" }
 *
 *   Server → Client:
 *     { type: "auth_ok",       userId: number }
 *     { type: "auth_error",    message: string }
 *     { type: "hole_context",  hole: HoleContext }
 *     { type: "leaderboard",   entries: LeaderboardEntry[] }
 *     { type: "score_saved",   holeNumber: number }
 *     { type: "shot_saved",    shotId: number }
 *     { type: "error",         message: string }
 *     { type: "pong" }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { db, tournamentsTable, playersTable, scoresTable, shotsTable, coursesTable, tournamentRoundsTable, holeDetailsTable } from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { verifyWatchToken } from "../lib/watch-token";
import { buildShotsFromGPX, type GPXRoundContext } from "../lib/wearables";
import { computePlaysLikeForHole } from "../lib/playsLike";
import { userHasConsent } from "../lib/consent";
import {
  recordWatchPosition,
  recordWatchPositionSample,
  flushWatchPositionSession,
  isWatchSessionMuted,
} from "../lib/watchPositionMetrics";
import { randomUUID } from "crypto";

// ── Per-connection state ─────────────────────────────────────────────────────
export interface WatchSession {
  ws: WebSocket;
  userId: number | null;
  tournamentId: number | null;
  round: number;
  // Per-connection identifier used by the position-rate metrics (Task #877)
  // so each in-process counter is keyed to one watch socket.
  sessionId: string;
  pushIntervalId: ReturnType<typeof setInterval> | null;
  // When true, the watch is in "round battery mode": server throttles its
  // periodic pushes from 30 s to 120 s so the watch radio can sleep longer.
  batteryMode: boolean;
  // Latest watch GPS, threaded into computePlaysLikeForHole so the
  // headwind/tailwind component is computed against the actual shot line
  // rather than a course-centre approximation. Updated by `subscribe`,
  // dedicated `position` messages, and any `score`/`shot` that includes lat/lng.
  playerLat: number | null;
  playerLng: number | null;
}

// Push intervals (ms) — battery mode multiplies idle-radio time by 4×.
const PUSH_INTERVAL_NORMAL_MS  = 30_000;
const PUSH_INTERVAL_BATTERY_MS = 120_000;

// Reasonable bounds on a client-supplied "submittedAt" timestamp so a clock-skewed
// or malicious watch cannot retro-date a score by years. 12 h covers a long round
// plus margin; future timestamps are clamped to "now".
export const MAX_OFFLINE_BACKDATE_MS = 12 * 60 * 60 * 1000;
export function clampClientTimestamp(clientMs: unknown): Date {
  const now = Date.now();
  if (typeof clientMs !== "number" || !Number.isFinite(clientMs)) return new Date(now);
  if (clientMs > now) return new Date(now);
  if (clientMs < now - MAX_OFFLINE_BACKDATE_MS) return new Date(now - MAX_OFFLINE_BACKDATE_MS);
  return new Date(clientMs);
}

function send(ws: WebSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ── Active session registry ──────────────────────────────────────────────────
// Indexed by authenticated userId so other modules (e.g. the marker countersign
// route in portal.ts / marker-live.ts) can push transient verification events
// to the player's paired watch over the existing /ws/watch socket.
const activeSessions = new Map<number, Set<WatchSession>>();

function registerSession(session: WatchSession): void {
  if (session.userId == null) return;
  let set = activeSessions.get(session.userId);
  if (!set) { set = new Set(); activeSessions.set(session.userId, set); }
  set.add(session);
}

function unregisterSession(session: WatchSession): void {
  if (session.userId == null) return;
  const set = activeSessions.get(session.userId);
  if (!set) return;
  set.delete(session);
  if (set.size === 0) activeSessions.delete(session.userId);
}

/**
 * Push a "hole_verified" event to every watch session belonging to the given
 * player. Used by the marker countersign / per-hole verify routes so the watch
 * can clear its "Awaiting marker" indicator immediately and play a transient
 * success haptic instead of waiting for the next periodic refresh (Task #484).
 *
 * `holes` is the list of hole numbers that just became verified. Pass an
 * empty array (or omit) when the entire round was verified — the watch will
 * treat it as a "clear all awaiting flags for this round" signal.
 */
export function notifyWatchHoleVerified(
  userId: number,
  payload: { round: number; holes?: number[]; submissionId?: number },
): void {
  const set = activeSessions.get(userId);
  if (!set || set.size === 0) return;
  const msg = {
    type: "hole_verified",
    round: payload.round,
    holes: payload.holes ?? [],
    submissionId: payload.submissionId ?? null,
  };
  for (const session of set) {
    send(session.ws, msg);
    // Re-push hole_context immediately so the next-hole + scored counts
    // reflect the freshly verified row without waiting for the 30 s push.
    void pushHoleContext(session);
  }
}

/**
 * Push a "hole_rejected" event to every watch session belonging to the given
 * player. Mirrors notifyWatchHoleVerified but for the rejection / dispute
 * path: the marker disagreed with the scorecard, so the watch should clear
 * its "verified" expectation, surface the rejection reason, and fire a
 * non-success (attention) haptic so the player notices immediately and can
 * correct disputed holes before leaving the green (Task #637).
 *
 * `holes` is the optional list of hole numbers flagged in the dispute. An
 * empty array (or omit) means the entire round was rejected.
 */
export function notifyWatchHoleRejected(
  userId: number,
  payload: { round: number; holes?: number[]; submissionId?: number; reason?: string },
): void {
  const set = activeSessions.get(userId);
  if (!set || set.size === 0) return;
  const msg = {
    type: "hole_rejected",
    round: payload.round,
    holes: payload.holes ?? [],
    submissionId: payload.submissionId ?? null,
    reason: payload.reason ?? "",
  };
  for (const session of set) {
    send(session.ws, msg);
  }
}

// ── Push helpers ─────────────────────────────────────────────────────────────
async function pushHoleContext(session: WatchSession): Promise<void> {
  if (!session.userId || !session.tournamentId) return;

  // Find player in tournament
  const [player] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(
      and(
        eq(playersTable.tournamentId, session.tournamentId),
        eq(playersTable.userId, session.userId),
      ),
    )
    .limit(1);
  if (!player) return;

  // Find first unsubmitted hole (lowest holeNumber without a score)
  const existingScores = await db
    .select({ holeNumber: scoresTable.holeNumber })
    .from(scoresTable)
    .where(
      and(
        eq(scoresTable.tournamentId, session.tournamentId),
        eq(scoresTable.playerId, player.id),
        eq(scoresTable.round, session.round),
      ),
    );
  const scored = new Set(existingScores.map((s) => s.holeNumber));

  // Resolve which courseId to use for this round
  const [roundRow] = await db
    .select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(
      and(
        eq(tournamentRoundsTable.tournamentId, session.tournamentId),
        eq(tournamentRoundsTable.roundNumber, session.round),
      ),
    )
    .limit(1);

  const [tournament] = await db
    .select({ courseId: tournamentsTable.courseId, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, session.tournamentId))
    .limit(1);

  const resolvedCourseId = roundRow?.courseId ?? tournament?.courseId;

  // Find first unscored hole (1–18). When all 18 holes are complete, nextHole = 18
  // (the last hole) so we don't emit holeNumber: 19 to the client.
  const unscoredHoles = Array.from({ length: 18 }, (_, i) => i + 1).filter((h) => !scored.has(h));
  const nextHole = unscoredHoles.length > 0 ? Math.min(...unscoredHoles) : 18;

  // Fetch per-hole par/handicap/yardage/green coordinates for watch display
  const [holeDetail] = resolvedCourseId
    ? await db
        .select({
          par:             holeDetailsTable.par,
          handicap:        holeDetailsTable.handicap,
          yardageBlue:     holeDetailsTable.yardageBlue,
          yardageWhite:    holeDetailsTable.yardageWhite,
          yardageRed:      holeDetailsTable.yardageRed,
          greenCentreLat:  holeDetailsTable.greenCentreLat,
          greenCentreLng:  holeDetailsTable.greenCentreLng,
        })
        .from(holeDetailsTable)
        .where(and(eq(holeDetailsTable.courseId, resolvedCourseId), eq(holeDetailsTable.holeNumber, nextHole)))
        .limit(1)
    : [null];

  // Plays-like yardage (wind + tee→green elevation). Falls back to course
  // centre as the tee proxy because the WS protocol does not yet carry the
  // watch's live GPS; the value is omitted entirely when wind/elev are
  // unknown so the iOS/Wear OS clients keep their existing "no PL" behaviour.
  const [course] = resolvedCourseId
    ? await db
        .select({ latitude: coursesTable.latitude, longitude: coursesTable.longitude })
        .from(coursesTable)
        .where(eq(coursesTable.id, resolvedCourseId))
        .limit(1)
    : [null];

  const playsLike = holeDetail
    ? await computePlaysLikeForHole({
        rawYards: holeDetail.yardageWhite ?? holeDetail.yardageBlue ?? holeDetail.yardageRed ?? null,
        greenLat: holeDetail.greenCentreLat,
        greenLng: holeDetail.greenCentreLng,
        // Prefer the watch's last-known GPS over the course centre so the
        // wind component reflects the player's actual shot line. Falls back
        // to course centre when the watch hasn't pushed a position yet.
        playerLat: session.playerLat,
        playerLng: session.playerLng,
        courseLat: course?.latitude ?? null,
        courseLng: course?.longitude ?? null,
      })
    : null;

  const payload: Record<string, unknown> = {
    type: "hole_context",
    tournamentName:  tournament?.name ?? "",
    holeNumber:      nextHole,           // canonical; parsed by iOS WatchWebSocketClient + Wear OS client
    currentHole:     nextHole,           // legacy alias
    holesPlayed:     scored.size,        // parsed by iOS TournamentStore; Wear OS WatchViewModel
    scoredHoles:     scored.size,        // legacy alias
    courseId:        resolvedCourseId,
    // Hole-specific details from holeDetailsTable (required by iOS TournamentStore.onHoleContext)
    par:             holeDetail?.par ?? 4,
    handicap:        holeDetail?.handicap ?? null,
    yardageBlue:     holeDetail?.yardageBlue ?? null,
    yardageWhite:    holeDetail?.yardageWhite ?? null,
    yardageRed:      holeDetail?.yardageRed ?? null,
    greenCentreLat:  holeDetail?.greenCentreLat ?? null,
    greenCentreLng:  holeDetail?.greenCentreLng ?? null,
  };
  if (playsLike != null) {
    payload.playsLikeYards = playsLike.playsLikeYards;
    payload.playsLikeWindAdj = playsLike.windAdj;
    payload.playsLikeElevAdj = playsLike.elevAdj;
    // Task #878 — surface the bearing-to-green and the wind's "from"
    // bearing so the watch / Wear OS / web clients can rotate a small
    // arrow next to the wind yardage to show head/cross/tail-wind at a
    // glance. Both are absolute compass degrees; clients compute the
    // relative arrow rotation as `(windDirDeg + 180) - bearingDeg`.
    payload.playsLikeBearingDeg = playsLike.bearingDeg;
    payload.playsLikeWindDirDeg = playsLike.windDirDeg;
  }
  send(session.ws, payload);
}

async function pushLeaderboard(session: WatchSession): Promise<void> {
  if (!session.userId || !session.tournamentId) return;

  const [player] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(
      and(
        eq(playersTable.tournamentId, session.tournamentId),
        eq(playersTable.userId, session.userId),
      ),
    )
    .limit(1);

  // Enforce tournament enrollment: authenticated user must be a player in this tournament
  if (!player) {
    send(session.ws, { type: "error", message: "not enrolled in this tournament" });
    return;
  }

  const players = await db
    .select({
      id:        playersTable.id,
      firstName: playersTable.firstName,
      lastName:  playersTable.lastName,
    })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, session.tournamentId));

  const entries = await Promise.all(
    players.map(async (p) => {
      const scores = await db
        .select({ strokes: scoresTable.strokes, holeNumber: scoresTable.holeNumber })
        .from(scoresTable)
        .where(
          and(
            eq(scoresTable.tournamentId, session.tournamentId!),
            eq(scoresTable.playerId, p.id),
            eq(scoresTable.round, session.round),
          ),
        );
      const total = scores.reduce((s, r) => s + (r.strokes ?? 0), 0);
      // Approximate toPar: par 4 per hole is a safe default; actual per-hole par improves with holeDetailsTable
      const toPar = total - scores.length * 4;
      return {
        playerId: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        total,
        toPar,
        holesPlayed: scores.length,
        isMe: p.id === player?.id,
      };
    }),
  );

  entries.sort((a, b) => a.toPar - b.toPar);
  entries.forEach((e, i) => Object.assign(e, { pos: i + 1 }));

  send(session.ws, { type: "leaderboard", entries });
}

// ── Handle incoming client messages ──────────────────────────────────────────
export async function handleMessage(
  session: WatchSession,
  raw: string,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    send(session.ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  const type = msg["type"] as string | undefined;

  if (type === "ping") {
    send(session.ws, { type: "pong" });
    return;
  }

  if (type === "auth") {
    const token = msg["token"] as string | undefined;
    if (!token) { send(session.ws, { type: "auth_error", message: "token required" }); return; }
    const userId = verifyWatchToken(token);
    if (!userId) { send(session.ws, { type: "auth_error", message: "invalid or expired token" }); return; }
    // If this socket was previously authenticated as a different user, drop the
    // stale registry mapping first so the prior user no longer receives events
    // through this connection. Without this, re-auth on the same socket would
    // leak hole_verified (and any future targeted) events across users.
    if (session.userId != null && session.userId !== userId) {
      unregisterSession(session);
    }
    session.userId = userId;
    registerSession(session);
    send(session.ws, { type: "auth_ok", userId });
    return;
  }

  if (!session.userId) {
    send(session.ws, { type: "auth_error", message: "Authenticate first" });
    return;
  }

  if (type === "subscribe") {
    session.tournamentId = (msg["tournamentId"] as number) ?? null;
    session.round = (msg["round"] as number) ?? 1;
    session.batteryMode = msg["batteryMode"] === true;
    // Optional initial GPS so the very first hole_context push uses the
    // watch's actual position instead of the course-centre fallback.
    const subLat = Number(msg["lat"]);
    const subLng = Number(msg["lng"]);
    if (Number.isFinite(subLat) && Number.isFinite(subLng)) {
      session.playerLat = subLat;
      session.playerLng = subLng;
    }

    // Clear previous push interval
    if (session.pushIntervalId) clearInterval(session.pushIntervalId);

    // Push immediately, then every 30 s (or 120 s in battery mode)
    const intervalMs = session.batteryMode ? PUSH_INTERVAL_BATTERY_MS : PUSH_INTERVAL_NORMAL_MS;
    await pushHoleContext(session);
    await pushLeaderboard(session);
    session.pushIntervalId = setInterval(async () => {
      await pushHoleContext(session);
      await pushLeaderboard(session);
    }, intervalMs);
    send(session.ws, { type: "subscribed", batteryMode: session.batteryMode, pushIntervalMs: intervalMs });
    return;
  }

  // Update the watch's last-known GPS without forcing a re-subscribe. The
  // next periodic (or score-triggered) hole_context push will use the new
  // coordinates so the wind/elevation adjustment stays in sync with the
  // player's position. We deliberately don't push immediately on every
  // position update — the watch sends one every few seconds, and the
  // existing 30 s / 120 s push cadence already governs delivery to clients.
  if (type === "position") {
    // Task #1393: ops can mute a runaway watch session from the super-admin
    // dashboard. Drop the message *before* updating any session state or
    // counting it toward metrics so the mute genuinely stops the flood
    // (a muted session shouldn't even drag the trend warning back up).
    // The mute clears when the watch reconnects (new sessionId) or the TTL
    // expires; until then this branch is a no-op.
    if (isWatchSessionMuted(session.sessionId)) {
      return;
    }
    const lat = Number(msg["lat"]);
    const lng = Number(msg["lng"]);
    // Optional GPS accuracy (metres) — not in the original protocol but
    // both the iOS and Wear OS clients now include it on flagged builds so
    // ops can tell a stuck-fix watch apart from one that's just drifting
    // through low-accuracy fixes (Task #1392).
    const accuracyRaw = msg["accuracy"];
    const accuracy =
      typeof accuracyRaw === "number" && Number.isFinite(accuracyRaw)
        ? accuracyRaw
        : null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      session.playerLat = lat;
      session.playerLng = lng;
    }
    // Task #877: count every position message we accept so ops can verify
    // the volume drop introduced by the watch-side debounce (Task #722).
    // userId is non-null here because the auth check above guards this block.
    if (session.userId != null) {
      recordWatchPosition({
        userId: session.userId,
        sessionId: session.sessionId,
        tournamentId: session.tournamentId,
        batteryMode: session.batteryMode,
      });
      // Task #1392 / Task #1676: also keep the raw payload around in the
      // shared `watch_position_samples` table so ops can drill in on a
      // misbehaving session and see what it's actually emitting (timestamps,
      // lat/lng, accuracy, mode) from any replica. Fire-and-forget — the
      // function catches its own DB errors so this never blocks or throws.
      void recordWatchPositionSample({
        sessionId: session.sessionId,
        lat,
        lng,
        accuracy,
        batteryMode: session.batteryMode,
      });
    }
    return;
  }

  // Toggle battery mode mid-round without re-subscribing.
  if (type === "battery_mode") {
    session.batteryMode = msg["enabled"] === true;
    if (session.pushIntervalId) clearInterval(session.pushIntervalId);
    if (session.tournamentId != null) {
      const intervalMs = session.batteryMode ? PUSH_INTERVAL_BATTERY_MS : PUSH_INTERVAL_NORMAL_MS;
      session.pushIntervalId = setInterval(async () => {
        await pushHoleContext(session);
        await pushLeaderboard(session);
      }, intervalMs);
      send(session.ws, { type: "battery_mode_ack", enabled: session.batteryMode, pushIntervalMs: intervalMs });
    }
    return;
  }

  if (type === "score") {
    if (!session.tournamentId) { send(session.ws, { type: "error", message: "subscribe first" }); return; }
    const holeNumber = msg["holeNumber"] as number;
    const strokes = msg["strokes"] as number;
    if (!holeNumber || !strokes) { send(session.ws, { type: "error", message: "holeNumber and strokes required" }); return; }

    // Opportunistically refresh session GPS from the score payload — players
    // tap the score in from the green, which is exactly the location we want
    // to use as the new "tee" for the next hole's plays-like push.
    const sLat = Number(msg["lat"]);
    const sLng = Number(msg["lng"]);
    if (Number.isFinite(sLat) && Number.isFinite(sLng)) {
      session.playerLat = sLat;
      session.playerLng = sLng;
    }

    const [player] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, session.tournamentId), eq(playersTable.userId, session.userId!)))
      .limit(1);
    if (!player) { send(session.ws, { type: "error", message: "not enrolled" }); return; }

    // When the watch played the hole standalone (offline), it sends both
    // `submittedOffline: true` and `clientSubmittedAt` (epoch ms at the moment
    // the player tapped Submit on the watch). We persist that as `submittedAt`
    // and force `isVerified=false` so marker validation re-runs against the
    // late-arriving entry instead of treating it as live.
    const submittedOffline = msg["submittedOffline"] === true;
    const submittedAt = submittedOffline
      ? clampClientTimestamp(msg["clientSubmittedAt"])
      : new Date();
    const updatedAt = new Date();

    await db.insert(scoresTable).values({
      tournamentId: session.tournamentId,
      playerId: player.id,
      round: session.round,
      holeNumber,
      strokes,
      isVerified: false,
      submittedAt,
      updatedAt,
    }).onConflictDoUpdate({
      // Unique constraint: (playerId, round, holeNumber) — see schema
      target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
      set: { strokes, isVerified: false, submittedAt, updatedAt },
    });

    send(session.ws, { type: "score_saved", holeNumber, submittedOffline });
    // Re-push context so watch shows next hole
    await pushHoleContext(session);
    await pushLeaderboard(session);
    return;
  }

  if (type === "shot") {
    if (!session.tournamentId) { send(session.ws, { type: "error", message: "subscribe first" }); return; }
    // Task #469 — block GPS shot ingestion when the member has withdrawn GPS consent.
    if (session.userId != null && !await userHasConsent(session.userId, "gps")) {
      send(session.ws, { type: "consent_required", category: "gps", message: "GPS shot tracking is turned off in your privacy settings." });
      return;
    }
    const holeNumber = msg["holeNumber"] as number;
    const shotNumber = msg["shotNumber"] as number;
    const lat = msg["lat"] as number | undefined;
    const lng = msg["lng"] as number | undefined;
    // A shot waypoint also doubles as a "where the player currently is"
    // signal — keep the session GPS in sync so the next plays-like push
    // uses the freshest fix without waiting for a separate `position`.
    if (typeof lat === "number" && typeof lng === "number" &&
        Number.isFinite(lat) && Number.isFinite(lng)) {
      session.playerLat = lat;
      session.playerLng = lng;
    }
    const club = msg["club"] as string | undefined;
    const distanceToPin = msg["distanceToPin"] as number | undefined;
    const distanceCarried = msg["distanceCarried"] as number | undefined;

    if (!holeNumber || !shotNumber) { send(session.ws, { type: "error", message: "holeNumber and shotNumber required" }); return; }

    const [player] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, session.tournamentId), eq(playersTable.userId, session.userId!)))
      .limit(1);
    if (!player) { send(session.ws, { type: "error", message: "not enrolled" }); return; }

    const [inserted] = await db.insert(shotsTable).values({
      tournamentId: session.tournamentId,
      playerId: player.id,
      round: session.round,
      holeNumber,
      shotNumber,
      club: club ?? null,
      // Use != null (not truthy) so valid zero coordinates (e.g. 0.0000) are preserved
      latitude: lat != null ? String(lat) : null,
      longitude: lng != null ? String(lng) : null,
      distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
      distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
      source: "watch",
    }).onConflictDoUpdate({
      target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
      set: {
        club: club ?? null,
        latitude: lat != null ? String(lat) : null,
        longitude: lng != null ? String(lng) : null,
        distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
        distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
        source: "watch",
      },
    }).returning({ id: shotsTable.id });

    send(session.ws, { type: "shot_saved", shotId: inserted?.id ?? 0 });
    return;
  }

  // putts — soft event from voice score entry ("two putts"). Persists the
  // putt count onto the existing scoresTable row for this (player, round, hole)
  // so it shows up in round summaries and season stats. If the score row does
  // not exist yet (e.g. putts spoken before strokes), we ack but do not insert
  // — strokes are required and the count can be re-spoken after the score.
  if (type === "putts") {
    if (!session.tournamentId) { send(session.ws, { type: "error", message: "subscribe first" }); return; }
    const holeNumber = Number(msg["holeNumber"]);
    const count      = Number(msg["count"]);
    if (!holeNumber || !Number.isFinite(count) || count < 0 || count > 10) {
      send(session.ws, { type: "error", message: "putts requires holeNumber + count(0-10)" });
      return;
    }

    const [player] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, session.tournamentId), eq(playersTable.userId, session.userId!)))
      .limit(1);
    if (!player) { send(session.ws, { type: "error", message: "not enrolled" }); return; }

    const updated = await db
      .update(scoresTable)
      .set({ putts: count, updatedAt: new Date() })
      .where(and(
        eq(scoresTable.playerId, player.id),
        eq(scoresTable.round, session.round),
        eq(scoresTable.holeNumber, holeNumber),
      ))
      .returning({ id: scoresTable.id });

    const persisted = updated.length > 0;
    if (!persisted) {
      console.log(`[ws-watch] putts received but no score row yet tid=${session.tournamentId} hole=${holeNumber} count=${count}`);
    }
    send(session.ws, { type: "putts_saved", holeNumber, count, persisted });
    return;
  }

  // complete_round — batch-run inference on all stored GPS waypoints for this round.
  // Converts watch shot records to GPXPoint[] and passes through buildShotsFromGPX,
  // enriching each row with inferred shotType, holeNumber, and distanceToPin.
  if (type === "complete_round") {
    if (!session.tournamentId || !session.userId) {
      send(session.ws, { type: "error", message: "subscribe first" });
      return;
    }
    const [player] = await db.select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, session.tournamentId), eq(playersTable.userId, session.userId)))
      .limit(1);
    if (!player) { send(session.ws, { type: "error", message: "not enrolled" }); return; }

    const [roundRow] = await db.select({ courseId: tournamentRoundsTable.courseId })
      .from(tournamentRoundsTable)
      .where(and(eq(tournamentRoundsTable.tournamentId, session.tournamentId), eq(tournamentRoundsTable.roundNumber, session.round)))
      .limit(1);
    const [tournament] = await db.select({ courseId: tournamentsTable.courseId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, session.tournamentId));
    const courseId = roundRow?.courseId ?? tournament?.courseId;
    if (!courseId) { send(session.ws, { type: "error", message: "course not found" }); return; }

    const rawShots = await db.select({
      id: shotsTable.id, latitude: shotsTable.latitude, longitude: shotsTable.longitude, recordedAt: shotsTable.recordedAt,
    })
      .from(shotsTable)
      .where(and(
        eq(shotsTable.playerId, player.id),
        eq(shotsTable.tournamentId, session.tournamentId),
        eq(shotsTable.round, session.round),
        sql`${shotsTable.latitude} is not null`,
        sql`${shotsTable.longitude} is not null`,
      ))
      .orderBy(asc(shotsTable.recordedAt));

    if (rawShots.length === 0) {
      send(session.ws, { type: "round_synced", shotsInferred: 0 });
      return;
    }

    const points = rawShots.map(s => ({
      lat: parseFloat(s.latitude!), lon: parseFloat(s.longitude!), elevation: null,
      time: s.recordedAt ? s.recordedAt.toISOString() : null,
    }));
    const ctx: GPXRoundContext = { playerId: player.id, tournamentId: session.tournamentId, round: session.round, courseId };
    const inferred = await buildShotsFromGPX(points, ctx);

    let updated = 0;
    for (let i = 0; i < inferred.length && i < rawShots.length; i++) {
      await db.update(shotsTable).set({
        holeNumber: inferred[i]!.holeNumber,
        shotNumber: inferred[i]!.shotNumber,
        shotType: (inferred[i]!.shotType ?? null) as never,
        distanceToPin: inferred[i]!.distanceToPin ?? null,
      }).where(eq(shotsTable.id, rawShots[i]!.id));
      updated++;
    }
    send(session.ws, { type: "round_synced", shotsInferred: updated });
    return;
  }

  send(session.ws, { type: "error", message: `unknown message type: ${type ?? ""}` });
}

// ── Attach WebSocket server to existing HTTP server ───────────────────────────
export function attachWatchWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/watch" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const session: WatchSession = {
      ws,
      userId: null,
      tournamentId: null,
      round: 1,
      sessionId: randomUUID(),
      pushIntervalId: null,
      batteryMode: false,
      playerLat: null,
      playerLng: null,
    };

    // Require auth within 15 seconds
    const authTimeout = setTimeout(() => {
      if (!session.userId) {
        send(ws, { type: "auth_error", message: "authentication timeout" });
        ws.close(4001, "auth_timeout");
      }
    }, 15_000);

    ws.on("message", (data) => {
      void handleMessage(session, data.toString());
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (session.pushIntervalId) clearInterval(session.pushIntervalId);
      // Task #877: flush any partial in-memory position-rate bucket so
      // per-minute totals aren't lost when the watch disconnects mid-minute.
      flushWatchPositionSession(session.sessionId);
      unregisterSession(session);
    });

    ws.on("error", (err) => {
      console.error("[ws-watch] error", err.message);
    });
  });

  console.log("[ws-watch] WebSocket server attached at /ws/watch");
}
