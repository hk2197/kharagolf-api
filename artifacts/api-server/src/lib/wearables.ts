/**
 * Wearable device integration service.
 *
 * Supports:
 *   - Garmin Connect — OAuth2 PKCE flow + webhook data push
 *   - Apple Health / Watch — GPX file upload + parsing
 *   - Arccos Caddie  — GPX / API polling (OAuth token exchange)
 *   - Generic GPX    — file upload for any device that exports GPX
 *
 * All OAuth flows require the corresponding provider credentials to be set
 * as environment secrets. When credentials are absent the module returns
 * safe-to-display error messages rather than throwing.
 */

import {
  db, wearableConnectionsTable, shotsTable, holeDetailsTable,
  wellnessDailyMetricsTable, wellnessSweepRunsTable,
  hrSamplesTable, hrActiveSessionsTable, userHealthPrefsTable, scoresTable,
  appUsersTable, organizationsTable, wearableReauthWowAcknowledgmentsTable,
} from "@workspace/db";
import { eq, and, sql, gte, isNotNull, asc, desc, inArray, lt } from "drizzle-orm";
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { logger as baseLogger } from "./logger";
import { sendPushToUsers } from "./push";
import { notifyWearableReauthRequired } from "./brandedNotifications.js";

const logger = baseLogger.child({ module: "wearables" });

// ── AES-256-CBC token encryption ──────────────────────────────────────────────
// OAuth tokens are encrypted at rest with AES-256-CBC.
//
// Key resolution order (most to least preferred):
//   1. WEARABLE_TOKEN_ENC_KEY  — dedicated 32-byte hex or plaintext secret
//   2. SESSION_SECRET           — shared app secret (acceptable in dev only)
//
// Production behaviour: if only SESSION_SECRET is set (no dedicated key), we
// still encrypt (no plaintext path), but OAuth connect flows will warn.
// If NEITHER key is set in production the OAuth callbacks return 503 so tokens
// are never persisted without encryption.

const _encKey = process.env.WEARABLE_TOKEN_ENC_KEY;
const _sessionKey = process.env.SESSION_SECRET;
const _isDev = process.env.NODE_ENV === "development";

// Whether we have a properly configured dedicated encryption key
const _hasDedicatedKey = !!_encKey;

// Derive a 32-byte key buffer (AES-256 requirement)
function _deriveKeyBuffer(raw: string): Buffer {
  return Buffer.from(raw.padEnd(32, "0").slice(0, 32), "utf8");
}

const TOKEN_KEY: Buffer | null =
  _encKey ? _deriveKeyBuffer(_encKey) :
  _sessionKey ? _deriveKeyBuffer(_sessionKey) :
  _isDev ? _deriveKeyBuffer("kharagolf-dev-fallback-secret-key") :
  null;

if (!TOKEN_KEY) {
  logger.error(
    "[wearables] Neither WEARABLE_TOKEN_ENC_KEY nor SESSION_SECRET is set in production — " +
    "OAuth token encryption is unavailable. Garmin/Arccos OAuth flows will be rejected.",
  );
}

if (!_hasDedicatedKey && !_isDev) {
  logger.warn(
    "[wearables] WEARABLE_TOKEN_ENC_KEY not set — falling back to SESSION_SECRET for " +
    "token encryption. Set WEARABLE_TOKEN_ENC_KEY to a dedicated 32-byte secret in production.",
  );
}

/**
 * Returns true if token encryption is available.
 * OAuth callback routes MUST check this before persisting tokens.
 */
function isTokenEncryptionAvailable(): boolean {
  return TOKEN_KEY !== null;
}

function encryptToken(plaintext: string): string {
  if (!TOKEN_KEY) throw new Error("Token encryption key not configured");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", TOKEN_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptToken(ciphertext: string): string {
  if (!TOKEN_KEY) return ""; // Cannot decrypt without key — return empty string
  try {
    const colonIdx = ciphertext.indexOf(":");
    if (colonIdx === -1) return ciphertext; // unencrypted legacy value
    const iv = Buffer.from(ciphertext.slice(0, colonIdx), "hex");
    const data = Buffer.from(ciphertext.slice(colonIdx + 1), "hex");
    const decipher = createDecipheriv("aes-256-cbc", TOKEN_KEY, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return ciphertext; // graceful fallback for unencrypted legacy rows
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type WearableProvider =
  | "garmin"
  | "apple_health"
  | "arccos"
  | "gpx"
  | "whoop"
  | "google_fit";

export type WellnessProvider = "garmin" | "apple_health" | "whoop" | "google_fit" | "manual";

/** Sources that legitimately produce daily wellness metrics. */
export const WELLNESS_PROVIDERS: WellnessProvider[] = [
  "garmin", "apple_health", "whoop", "google_fit", "manual",
];

export interface GPXPoint {
  lat: number;
  lon: number;
  elevation: number | null;
  time: string | null;
}

export interface GPXTrack {
  name: string | null;
  points: GPXPoint[];
  totalDistanceMeters: number;
  durationSeconds: number | null;
  startTime: string | null;
}

export interface OAuthInitResult {
  url: string;
  state: string;
}

export interface WearableSyncResult {
  synced: boolean;
  message: string;
  activities?: number;
}

// ── GPX Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a GPX XML string into a structured GPXTrack.
 * Uses lightweight regex/string extraction — no external XML library needed.
 * Handles Garmin Connect, Apple Watch workout exports, and standard GPX 1.1.
 */
export function parseGPXFile(xmlContent: string): GPXTrack {
  // Extract track name
  const nameMatch = xmlContent.match(/<name>([^<]*)<\/name>/i);
  const name = nameMatch ? nameMatch[1].trim() : null;

  // Extract all trackpoints
  const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  const points: GPXPoint[] = [];

  let match: RegExpExecArray | null;
  while ((match = trkptRegex.exec(xmlContent)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const inner = match[3];

    const eleMatch = inner.match(/<ele>([^<]*)<\/ele>/i);
    const timeMatch = inner.match(/<time>([^<]*)<\/time>/i);

    points.push({
      lat,
      lon,
      elevation: eleMatch ? parseFloat(eleMatch[1]) : null,
      time: timeMatch ? timeMatch[1].trim() : null,
    });
  }

  // Compute total distance using Haversine formula
  let totalDistanceMeters = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistanceMeters += haversineMeters(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon,
    );
  }

  // Duration from first to last timestamp
  let durationSeconds: number | null = null;
  const startTime = points[0]?.time ?? null;
  if (startTime && points[points.length - 1]?.time) {
    const start = new Date(startTime).getTime();
    const end = new Date(points[points.length - 1].time!).getTime();
    if (!isNaN(start) && !isNaN(end)) durationSeconds = Math.round((end - start) / 1000);
  }

  return { name, points, totalDistanceMeters, durationSeconds, startTime };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── OAuth State (HMAC-signed, time-bounded, CSRF-safe) ───────────────────────

const OAUTH_STATE_SECRET = process.env.SESSION_SECRET ?? process.env.DATABASE_URL ?? "kharagolf-dev-fallback";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create a HMAC-signed OAuth state token encoding userId + timestamp.
 * The state prevents CSRF and account-linking attacks in the callback.
 */
export function createOAuthState(userId: number): string {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const sig = createHmac("sha256", OAUTH_STATE_SECRET).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64url");
}

/**
 * Verify and decode an OAuth state token.
 * Returns the payload if valid, or null if tampered / expired.
 */
export function verifyOAuthState(state: string): { userId: number; ts: number } | null {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(state, "base64url").toString());
    const expected = createHmac("sha256", OAUTH_STATE_SECRET).update(payload).digest("hex");
    if (sig !== expected) return null; // tampered
    const data = JSON.parse(payload) as { userId: number; ts: number };
    if (Date.now() - data.ts > OAUTH_STATE_TTL_MS) return null; // expired
    return data;
  } catch {
    return null;
  }
}

// ── OAuth Flows ───────────────────────────────────────────────────────────────

/**
 * Generate a Garmin Connect OAuth2 authorization URL.
 * Requires GARMIN_CONSUMER_KEY and GARMIN_CONSUMER_SECRET env vars.
 * Returns a descriptive error when credentials are absent.
 */
export function getGarminOAuthUrl(userId: number, baseUrl: string): OAuthInitResult | { error: string } {
  const key = process.env.GARMIN_CONSUMER_KEY;
  if (!key) {
    return { error: "Garmin Connect integration not configured. Please contact your club administrator." };
  }

  const state = createOAuthState(userId);
  const callbackUrl = encodeURIComponent(`${baseUrl}/api/portal/wearables/garmin/callback`);

  // Garmin Health API OAuth2 endpoint
  const url = `https://connect.garmin.com/oauthConfirm`
    + `?oauth_consumer_key=${encodeURIComponent(key)}`
    + `&oauth_callback=${callbackUrl}`
    + `&state=${state}`;

  return { url, state };
}

/**
 * Generate an Arccos Caddie OAuth2 authorization URL.
 * Requires ARCCOS_CLIENT_ID env var.
 */
export function getArccosOAuthUrl(userId: number, baseUrl: string): OAuthInitResult | { error: string } {
  const clientId = process.env.ARCCOS_CLIENT_ID;
  if (!clientId) {
    return { error: "Arccos Caddie integration not configured. Please contact your club administrator." };
  }

  const state = createOAuthState(userId);
  const callbackUrl = encodeURIComponent(`${baseUrl}/api/portal/wearables/arccos/callback`);
  const url = `https://arccosgolf.com/oauth/authorize`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&response_type=code`
    + `&redirect_uri=${callbackUrl}`
    + `&state=${state}`;

  return { url, state };
}

// ── Garmin User ID Fetch ──────────────────────────────────────────────────────

/**
 * Fetch the Garmin Connect user ID for a freshly issued access token.
 * Calls GET /wellness-api/rest/user/id with an OAuth 1.0a signed request.
 * Returns the Garmin userId string on success, null on failure.
 */
async function fetchGarminUserId(
  accessToken: string,
  tokenSecret: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<string | null> {
  const url = "https://healthapi.garmin.com/wellness-api/rest/user/id";
  const method = "GET";
  const oauthNonce = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const oauthTimestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: oauthNonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  // Build the OAuth 1.0a base string and signature
  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  const { createHmac } = await import("crypto");
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");
  oauthParams.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(", ");

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, "[wearables] Garmin user ID fetch failed");
    return null;
  }

  const json = await res.json() as { userId?: string };
  return json.userId ?? null;
}

// ── Token Exchange (OAuth Callback) ───────────────────────────────────────────

/**
 * Exchange an authorization code for a Garmin access token and persist it.
 * Validates the HMAC-signed state to prevent CSRF account-linking attacks.
 * On success, marks the wearable connection as "connected".
 */
export async function handleGarminCallback(
  code: string,
  state: string,
  sessionUserId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // CSRF / account-linking protection: verify state before touching DB
  const statePayload = verifyOAuthState(state);
  if (!statePayload) return { ok: false, error: "Invalid or expired OAuth state — please restart the connection process" };
  if (statePayload.userId !== sessionUserId) return { ok: false, error: "State userId mismatch — possible CSRF attempt" };
  const userId = sessionUserId;

  // Fail closed: never persist tokens without encryption
  if (!isTokenEncryptionAvailable()) {
    return { ok: false, error: "Wearable token encryption is not configured — set WEARABLE_TOKEN_ENC_KEY or SESSION_SECRET" };
  }

  const key = process.env.GARMIN_CONSUMER_KEY;
  const secret = process.env.GARMIN_CONSUMER_SECRET;
  if (!key || !secret) return { ok: false, error: "Garmin credentials not configured" };

  try {
    // Exchange code → token via Garmin Health API.
    // Use fetchWithRetry so transient 5xx / 429 from Garmin's OAuth host
    // don't drop the user back into a re-auth loop (Task #847).
    const res = await fetchWithRetry("https://connectapi.garmin.com/oauth-service/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        oauth_consumer_key: key,
        oauth_token: code,
        oauth_verifier: code,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "[wearables] Garmin token exchange failed");
      return { ok: false, error: `Garmin returned HTTP ${res.status}` };
    }

    const text = await res.text();
    const params = new URLSearchParams(text);
    const rawAccessToken = params.get("oauth_token") ?? "";
    const rawTokenSecret = params.get("oauth_token_secret") ?? "";
    const accessToken = encryptToken(rawAccessToken);
    const tokenSecret = encryptToken(rawTokenSecret);

    // Fetch the Garmin Connect user ID using the newly issued token.
    // The Garmin Health API identifies users by a string userId distinct from
    // the OAuth token; we store it so webhook pushes can be attributed back.
    let externalUserId: string | null = null;
    try {
      const userIdRes = await fetchGarminUserId(rawAccessToken, rawTokenSecret, key, secret);
      if (userIdRes) externalUserId = userIdRes;
    } catch (uidErr) {
      logger.warn({ uidErr }, "[wearables] Could not fetch Garmin user ID — webhook auto-sync will not work until re-auth");
    }

    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "garmin",
      status: "connected",
      accessToken,
      refreshToken: tokenSecret,
      externalUserId,
      connectedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
      set: { status: "connected", accessToken, refreshToken: tokenSecret, externalUserId, connectedAt: new Date(), updatedAt: new Date() },
    });

    return { ok: true };
  } catch (err: unknown) {
    logger.error({ err }, "[wearables] Garmin callback error");
    return { ok: false, error: String(err) };
  }
}

/**
 * Exchange an Arccos authorization code for an access token and persist it.
 * Validates the HMAC-signed state to prevent CSRF account-linking attacks.
 */
export async function handleArccosCallback(
  code: string,
  state: string,
  sessionUserId: number,
  baseUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // CSRF / account-linking protection: verify state before touching DB
  const statePayload = verifyOAuthState(state);
  if (!statePayload) return { ok: false, error: "Invalid or expired OAuth state — please restart the connection process" };
  if (statePayload.userId !== sessionUserId) return { ok: false, error: "State userId mismatch — possible CSRF attempt" };
  const userId = sessionUserId;

  // Fail closed: never persist tokens without encryption
  if (!isTokenEncryptionAvailable()) {
    return { ok: false, error: "Wearable token encryption is not configured — set WEARABLE_TOKEN_ENC_KEY or SESSION_SECRET" };
  }

  const clientId = process.env.ARCCOS_CLIENT_ID;
  const clientSecret = process.env.ARCCOS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "Arccos credentials not configured" };

  try {
    const res = await fetchWithRetry("https://arccosgolf.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${baseUrl}/api/portal/wearables/arccos/callback`,
      }),
    });

    if (!res.ok) return { ok: false, error: `Arccos returned HTTP ${res.status}` };

    const data = (await res.json()) as { access_token?: string };
    const accessToken = encryptToken(data.access_token ?? "");

    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "arccos",
      status: "connected",
      accessToken,
      connectedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
      set: { status: "connected", accessToken, connectedAt: new Date(), updatedAt: new Date() },
    });

    return { ok: true };
  } catch (err: unknown) {
    logger.error({ err }, "[wearables] Arccos callback error");
    return { ok: false, error: String(err) };
  }
}

// ── GPX Upload & Shot Ingestion ───────────────────────────────────────────────

export interface GPXRoundContext {
  playerId: number;
  tournamentId: number;
  round: number;
  courseId: number;
}

interface HoleGreen {
  holeNumber: number;
  lat: number;
  lng: number;
}

function metersToYards(m: number): number {
  return m * 1.09361;
}

/** Infer shot type from position within hole (first=tee, last if <10m=putt, else fairway/approach). */
function inferShotType(
  shotIdx: number,
  totalShots: number,
  distToGreenM: number,
): "tee" | "fairway" | "approach" | "chip" | "putt" {
  if (shotIdx === 0) return "tee";
  if (distToGreenM < 10) return "putt";
  if (distToGreenM < 50) return "chip";
  if (distToGreenM < 150) return "approach";
  return "fairway";
}

/**
 * Assign GPS waypoints to holes using nearest-green heuristic.
 * Used both for GPX file uploads and for watch-recorded waypoints (sync-round).
 */
export async function buildShotsFromGPX(
  points: GPXPoint[],
  context: GPXRoundContext,
): Promise<Array<typeof shotsTable.$inferInsert>> {
  const holeRows = await db
    .select({
      holeNumber: holeDetailsTable.holeNumber,
      greenCentreLat: holeDetailsTable.greenCentreLat,
      greenCentreLng: holeDetailsTable.greenCentreLng,
    })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, context.courseId));

  if (holeRows.length === 0) return [];

  const greens: HoleGreen[] = holeRows
    .filter(h => h.greenCentreLat !== null && h.greenCentreLng !== null)
    .map(h => ({
      holeNumber: h.holeNumber,
      lat: parseFloat(h.greenCentreLat!),
      lng: parseFloat(h.greenCentreLng!),
    }));

  if (greens.length === 0) return [];

  // Assign each waypoint to the hole whose green it is approaching
  // Strategy: track cumulative distance; once within 20m of a green, move to next hole
  const sortedGreens = [...greens].sort((a, b) => a.holeNumber - b.holeNumber);
  const shots: Array<typeof shotsTable.$inferInsert> = [];

  let greenIdx = 0;
  let shotNumber = 1;

  for (const point of points) {
    if (greenIdx >= sortedGreens.length) break;
    const green = sortedGreens[greenIdx];
    const distToGreenM = haversineMeters(point.lat, point.lon, green.lat, green.lng);
    const distToGreenYards = metersToYards(distToGreenM);

    const shot: typeof shotsTable.$inferInsert = {
      tournamentId: context.tournamentId,
      playerId: context.playerId,
      round: context.round,
      holeNumber: green.holeNumber,
      shotNumber,
      shotType: inferShotType(shotNumber - 1, points.length, distToGreenM),
      latitude: String(point.lat),
      longitude: String(point.lon),
      distanceToPin: String(Math.round(distToGreenYards * 10) / 10),
      source: "watch",
      recordedAt: point.time ? new Date(point.time) : new Date(),
    };

    shots.push(shot);
    shotNumber++;

    // Advance to next hole once within 20 m of the green
    if (distToGreenM < 20) {
      greenIdx++;
      shotNumber = 1;
    }
  }

  return shots;
}

/**
 * Process an uploaded GPX file for a user:
 * 1. Parse the GPX content
 * 2. Record the connection as "connected" (gpx provider)
 * 3. If round context is supplied, insert shots into the shots table
 * 4. Return the parsed track
 */
export async function processGPXUpload(
  userId: number,
  gpxContent: string,
  context?: GPXRoundContext,
): Promise<{ track: GPXTrack; shotsInserted: number; ok: true } | { ok: false; error: string }> {
  try {
    const track = parseGPXFile(gpxContent);
    if (track.points.length === 0) {
      return { ok: false, error: "No trackpoints found in GPX file. Please export a valid GPS track." };
    }

    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "gpx",
      status: "connected",
      connectedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
      set: { status: "connected", updatedAt: new Date() },
    });

    let shotsInserted = 0;
    if (context) {
      const shotRows = await buildShotsFromGPX(track.points, context);
      if (shotRows.length > 0) {
        // Idempotent insert: duplicate GPX uploads or retries skip existing shots
        const result = await db
          .insert(shotsTable)
          .values(shotRows)
          .onConflictDoNothing({
            target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
          })
          .returning({ id: shotsTable.id });
        shotsInserted = result.length;
      }
    }

    logger.info({ userId, points: track.points.length, shotsInserted, distanceM: track.totalDistanceMeters }, "[wearables] GPX processed");
    return { track, shotsInserted, ok: true };
  } catch (err: unknown) {
    logger.error({ err, userId }, "[wearables] GPX processing error");
    return { ok: false, error: "Failed to parse GPX file." };
  }
}

// ── Wearable Data Sync ────────────────────────────────────────────────────────

/**
 * Pull latest activity data from a connected wearable provider.
 * Currently supports Garmin; other providers return a human-friendly message
 * noting that real-time sync requires club-level API credentials.
 */
export async function syncWearableData(
  userId: number,
  provider: WearableProvider,
  retryOpts: FetchWithRetryOpts = {},
): Promise<WearableSyncResult> {
  const [conn] = await db.select()
    .from(wearableConnectionsTable)
    .where(and(
      eq(wearableConnectionsTable.userId, userId),
      eq(wearableConnectionsTable.provider, provider),
    ));

  if (!conn || conn.status !== "connected") {
    return { synced: false, message: `No active ${provider} connection found.` };
  }

  if (provider === "garmin") {
    const key = process.env.GARMIN_CONSUMER_KEY;
    const secret = process.env.GARMIN_CONSUMER_SECRET;
    if (!key || !secret || !conn.accessToken) {
      return { synced: false, message: "Garmin credentials not configured." };
    }

    try {
      const accessToken = decryptToken(conn.accessToken ?? "");

      // Fetch last 7 days of activities from Garmin Health API.
      // Use fetchWithRetry so a transient 5xx / 429 from Garmin's Health API
      // doesn't surface as a hard "sync failed" to the user on the on-demand
      // sync-now route (Task #987).
      const uploadStart = Math.floor(Date.now() / 1000) - 7 * 86400;
      const res = await fetchWithRetry(
        `https://healthapi.garmin.com/wellness-api/rest/activities?uploadStartTimeInSeconds=${uploadStart}`,
        {
          headers: {
            Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${accessToken}"`,
          },
        },
        retryOpts,
      );

      if (!res.ok) {
        return { synced: false, message: `Garmin sync returned HTTP ${res.status}.` };
      }

      const data = (await res.json()) as { activityList?: unknown[] };
      const count = data.activityList?.length ?? 0;

      await db.update(wearableConnectionsTable)
        .set({ updatedAt: new Date() })
        .where(and(
          eq(wearableConnectionsTable.userId, userId),
          eq(wearableConnectionsTable.provider, "garmin"),
        ));

      return { synced: true, message: `Synced ${count} activities from Garmin Connect.`, activities: count };
    } catch (err: unknown) {
      logger.error({ err, userId }, "[wearables] Garmin sync error");
      return { synced: false, message: "Garmin sync failed. Please reconnect your device." };
    }
  }

  if (provider === "arccos") {
    // Arccos real-time push sync requires Arccos club-level API credentials.
    // The connection (OAuth2 token) is stored; shot data is available via Arccos
    // webhook push once the partnership agreement and API keys are in place.
    return {
      synced: false,
      message: "Arccos Caddie sync requires club-level API credentials. Contact your administrator to enable automatic shot ingestion.",
    };
  }

  if (provider === "apple_health") {
    // Apple Health data lives exclusively on-device. Pull sync from the server
    // side is not supported by the Apple HealthKit API. Data must be pushed by
    // the mobile app via the GPX upload or the batch-scores endpoint.
    return {
      synced: false,
      message: "Apple Health data must be pushed from the mobile app — server-side pull sync is not supported by HealthKit.",
    };
  }

  if (provider === "gpx") {
    return { synced: false, message: "GPX data is uploaded directly via the file upload endpoint — no background sync required." };
  }

  if (provider === "whoop") {
    return await syncWhoopWellness(userId, conn, retryOpts);
  }

  if (provider === "google_fit") {
    return await syncGoogleFitWellness(userId, conn, retryOpts);
  }

  return { synced: false, message: `Server-side sync is not available for provider '${provider}'. Use the mobile app or GPX upload instead.` };
}

// ── Whoop OAuth + wellness pull ───────────────────────────────────────────────

/**
 * Generate a Whoop OAuth2 authorization URL.
 * Whoop uses standard OAuth2 with PKCE for public clients; for server-side
 * confidential clients we use the authorization-code flow with client_id and
 * client_secret. Requires WHOOP_CLIENT_ID env var.
 */
export function getWhoopOAuthUrl(userId: number, baseUrl: string): OAuthInitResult | { error: string } {
  const clientId = process.env.WHOOP_CLIENT_ID;
  if (!clientId) {
    return { error: "Whoop integration not configured. Please contact your club administrator." };
  }
  const state = createOAuthState(userId);
  const callbackUrl = encodeURIComponent(`${baseUrl}/api/portal/wearables/whoop/callback`);
  // Whoop Health API scopes for recovery / sleep / cycles / workouts.
  const scope = encodeURIComponent("read:recovery read:sleep read:cycles read:workout read:profile");
  const url = `https://api.prod.whoop.com/oauth/oauth2/auth`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&response_type=code`
    + `&scope=${scope}`
    + `&redirect_uri=${callbackUrl}`
    + `&state=${state}`;
  return { url, state };
}

export async function handleWhoopCallback(
  code: string,
  state: string,
  sessionUserId: number,
  baseUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const statePayload = verifyOAuthState(state);
  if (!statePayload) return { ok: false, error: "Invalid or expired OAuth state — please restart the connection process" };
  if (statePayload.userId !== sessionUserId) return { ok: false, error: "State userId mismatch — possible CSRF attempt" };
  const userId = sessionUserId;

  if (!isTokenEncryptionAvailable()) {
    return { ok: false, error: "Wearable token encryption is not configured — set WEARABLE_TOKEN_ENC_KEY or SESSION_SECRET" };
  }

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "Whoop credentials not configured" };

  try {
    // Use fetchWithRetry so a transient 5xx / 429 from Whoop's OAuth host
    // doesn't drop the user back at the connect screen mid-flow (Task #987).
    const res = await fetchWithRetry("https://api.prod.whoop.com/oauth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/portal/wearables/whoop/callback`,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[wearables] Whoop token exchange failed");
      return { ok: false, error: `Whoop returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    const accessToken = encryptToken(data.access_token ?? "");
    const refreshToken = data.refresh_token ? encryptToken(data.refresh_token) : null;
    const tokenExpiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken,
      refreshToken,
      tokenExpiresAt,
      connectedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
      set: { status: "connected", accessToken, refreshToken, tokenExpiresAt, connectedAt: new Date(), updatedAt: new Date() },
    });
    return { ok: true };
  } catch (err: unknown) {
    logger.error({ err }, "[wearables] Whoop callback error");
    return { ok: false, error: String(err) };
  }
}

/**
 * Mark a wearable connection as needing re-authentication.
 * Triggered when an OAuth token refresh or upstream API call returns 401/403,
 * so the mobile app can prompt the user to reconnect.
 */
async function markConnectionNeedsReauth(
  userId: number,
  provider: WearableProvider,
  reason: string,
): Promise<void> {
  // Atomically flip ONLY rows that are currently not already in needs_reauth.
  // The conditional WHERE + .returning() makes the dedupe concurrency-safe:
  // under parallel sweeps / token-refresh retries, exactly one UPDATE wins and
  // returns a row; the others affect zero rows and silently no-op. This is
  // what prevents repeated push notifications to the player.
  const flipped = await db.update(wearableConnectionsTable)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(and(
      eq(wearableConnectionsTable.userId, userId),
      eq(wearableConnectionsTable.provider, provider),
      sql`${wearableConnectionsTable.status} <> 'needs_reauth'`,
    ))
    .returning({ id: wearableConnectionsTable.id });

  if (flipped.length === 0) return; // already needs_reauth, or no row exists

  logger.warn({ userId, provider, reason }, "[wearables] connection flipped to needs_reauth");

  // Fire a one-time push so the player knows to reconnect — without it they
  // only see the badge if they happen to open the wellness section. Tapping
  // the notification deep-links to the profile screen (see mobile _layout
  // handler for type === "wearable_disconnected").
  // Task #1240 — fire-and-forget: the result is discarded, no telemetry is
  // recorded based on the PushDeliveryResult, so the no-Expo-token vs
  // delivery-failed distinction (the concern in Task #1070) does not need
  // `classifyPushDelivery` here. Wearable-disconnect alerts are best-effort
  // companion notifications to the in-app banner already shown on the
  // wellness screen — never the sole signal to the user.
  try {
    const providerLabel = PROVIDER_LABELS[provider] ?? provider;
    await sendPushToUsers(
      [userId],
      "Wearable disconnected",
      `Your ${providerLabel} sign-in expired. Tap to reconnect and resume syncing.`,
      { type: "wearable_disconnected", provider, screen: "profile" },
    );
  } catch (err) {
    // Push delivery failure must not break the reauth flip itself.
    logger.warn({ err, userId, provider }, "[wearables] needs_reauth push notify failed");
  }

  // Task #2008 — central branded `wearable.reauth.required` dispatch (push +
  // branded email + digest fan-out per recipient preference). Layered on top
  // of the bespoke push above so users with a registered email also get a
  // branded message they can act on from inbox without opening the app.
  void notifyWearableReauthRequired({
    userIds: [userId],
    provider,
    providerLabel: PROVIDER_LABELS[provider] ?? provider,
  });
}

const PROVIDER_LABELS: Partial<Record<WearableProvider, string>> = {
  whoop: "Whoop",
  google_fit: "Google Fit",
  garmin: "Garmin",
  apple_health: "Apple Health",
  arccos: "Arccos",
  gpx: "GPX",
};

/** Buffer (ms) before tokenExpiresAt at which we proactively refresh. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Refresh a Whoop OAuth access token using the stored refresh token.
 * Returns the new plaintext access token, or null if refresh failed
 * (in which case the connection is marked as needs_reauth).
 */
export async function refreshWhoopToken(
  conn: typeof wearableConnectionsTable.$inferSelect,
  retryOpts: FetchWithRetryOpts = {},
): Promise<string | null> {
  if (!conn.refreshToken) {
    await markConnectionNeedsReauth(conn.userId, "whoop", "no refresh token");
    return null;
  }
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.warn("[wearables] Whoop credentials not configured — cannot refresh token");
    return null;
  }
  const refreshTokenPlain = decryptToken(conn.refreshToken);
  try {
    // Transient 5xx / 429 from Whoop's OAuth host should not flip a healthy
    // connection into a re-auth loop (Task #847). 401 / 403 short-circuit
    // immediately inside fetchWithRetry, so the needs_reauth path below still
    // fires promptly when the refresh token is genuinely revoked.
    const res = await fetchWithRetry("https://api.prod.whoop.com/oauth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenPlain,
        client_id: clientId,
        client_secret: clientSecret,
        scope: "offline",
      }),
    }, retryOpts);
    if (res.status === 401 || res.status === 403) {
      await markConnectionNeedsReauth(conn.userId, "whoop", `refresh HTTP ${res.status}`);
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, userId: conn.userId }, "[wearables] Whoop token refresh failed");
      return null;
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      await markConnectionNeedsReauth(conn.userId, "whoop", "refresh response missing access_token");
      return null;
    }
    const accessToken = encryptToken(data.access_token);
    const refreshToken = data.refresh_token ? encryptToken(data.refresh_token) : conn.refreshToken;
    const tokenExpiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
    await db.update(wearableConnectionsTable)
      .set({ accessToken, refreshToken, tokenExpiresAt, status: "connected", updatedAt: new Date() })
      .where(and(
        eq(wearableConnectionsTable.userId, conn.userId),
        eq(wearableConnectionsTable.provider, "whoop"),
      ));
    return data.access_token;
  } catch (err) {
    logger.error({ err, userId: conn.userId }, "[wearables] Whoop token refresh error");
    return null;
  }
}

/**
 * Refresh a Google Fit OAuth access token using the stored refresh token.
 * Returns the new plaintext access token, or null if refresh failed
 * (in which case the connection is marked as needs_reauth).
 */
export async function refreshGoogleFitToken(
  conn: typeof wearableConnectionsTable.$inferSelect,
  retryOpts: FetchWithRetryOpts = {},
): Promise<string | null> {
  if (!conn.refreshToken) {
    await markConnectionNeedsReauth(conn.userId, "google_fit", "no refresh token");
    return null;
  }
  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.warn("[wearables] Google Fit credentials not configured — cannot refresh token");
    return null;
  }
  const refreshTokenPlain = decryptToken(conn.refreshToken);
  try {
    // Transient 5xx / 429 from Google's OAuth host should not flip a healthy
    // connection into a re-auth loop (Task #847). 401 / 403 are not retried
    // and still flip to needs_reauth below.
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenPlain,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    }, retryOpts);
    if (res.status === 401 || res.status === 403) {
      await markConnectionNeedsReauth(conn.userId, "google_fit", `refresh HTTP ${res.status}`);
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, userId: conn.userId }, "[wearables] Google Fit token refresh failed");
      return null;
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      await markConnectionNeedsReauth(conn.userId, "google_fit", "refresh response missing access_token");
      return null;
    }
    const accessToken = encryptToken(data.access_token);
    // Google often does NOT return a new refresh_token on refresh — keep the original.
    const refreshToken = data.refresh_token ? encryptToken(data.refresh_token) : conn.refreshToken;
    const tokenExpiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
    await db.update(wearableConnectionsTable)
      .set({ accessToken, refreshToken, tokenExpiresAt, status: "connected", updatedAt: new Date() })
      .where(and(
        eq(wearableConnectionsTable.userId, conn.userId),
        eq(wearableConnectionsTable.provider, "google_fit"),
      ));
    return data.access_token;
  } catch (err) {
    logger.error({ err, userId: conn.userId }, "[wearables] Google Fit token refresh error");
    return null;
  }
}

/**
 * Return a usable plaintext access token for the connection, refreshing it
 * proactively if it is within TOKEN_REFRESH_BUFFER_MS of expiry.
 */
async function ensureFreshAccessToken(
  conn: typeof wearableConnectionsTable.$inferSelect,
): Promise<string | null> {
  const isExpiring =
    conn.tokenExpiresAt !== null &&
    conn.tokenExpiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;
  if (isExpiring) {
    if (conn.provider === "whoop") return await refreshWhoopToken(conn);
    if (conn.provider === "google_fit") return await refreshGoogleFitToken(conn);
  }
  return conn.accessToken ? decryptToken(conn.accessToken) : null;
}

// ── Provider request pacing: retry + backoff + concurrency cap ────────────────
//
// Background sweeps that touch many users at once can burst-hit upstream
// providers (Whoop / Google Fit) and trip their rate limits, marking
// otherwise-healthy connections as failed. We mitigate this with two layers:
//
//   1. fetchWithRetry — retries 429 / 5xx responses with exponential backoff
//      + jitter, honoring any Retry-After header. 401 / 403 are NOT retried
//      (those are real auth failures that must flip to needs_reauth).
//   2. A per-provider concurrency cap inside sweepWellnessConnections (see
//      runWithConcurrency) so we never have more than N in-flight requests
//      to the same upstream at once.
//
// All knobs are overridable for tests via the SweepOptions / FetchWithRetryOpts
// parameter so we don't have to wait on real timers.

export interface FetchWithRetryOpts {
  /** Maximum number of retry attempts after the first try. Default: 3. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff: delay = base * 2^attempt + jitter. Default: 500. */
  baseDelayMs?: number;
  /** Upper bound on a single sleep step (ms). Default: 30_000. */
  maxDelayMs?: number;
  /** Sleep implementation (overridable in tests). Default: setTimeout-based. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Random source for jitter (overridable in tests). Default: Math.random. */
  rng?: () => number;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * fetch wrapper that transparently retries transient failures (network errors,
 * HTTP 429, HTTP 5xx) with exponential backoff + jitter. Honors Retry-After
 * (seconds) when the server provides it. Returns the final Response (which may
 * still be non-OK) when retries are exhausted; throws only if every attempt
 * threw a network error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOpts = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleepFn ?? DEFAULT_SLEEP;
  const rng = opts.rng ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt)) + Math.floor(rng() * 250);
      logger.warn({ url, err, attempt: attempt + 1, delayMs: delay }, "[wearables] network error, retrying");
      await sleep(delay);
      continue;
    }
    // Only 429 and 5xx are transient. Everything else (including 401/403)
    // returns immediately so the caller can react.
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt === maxRetries) return res;

    let delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) {
        delay = Math.max(delay, Math.min(maxDelayMs, secs * 1000));
      }
    }
    delay += Math.floor(rng() * 250);
    logger.warn({ url, status: res.status, attempt: attempt + 1, delayMs: delay }, "[wearables] transient provider failure, retrying");
    await sleep(delay);
  }
  // Unreachable: the loop above always returns or throws.
  throw lastErr ?? new Error("fetchWithRetry: exhausted without response");
}

/**
 * Run an async worker over a list of items with at most `concurrency`
 * workers in flight at any time. Errors thrown by individual workers are
 * caught and ignored — the caller is expected to handle per-item failures.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        await worker(items[idx]);
      } catch {
        // Swallowed — sweep callers handle / log per-item failures.
      }
    }
  });
  await Promise.all(runners);
}

async function syncWhoopWellness(
  userId: number,
  conn: typeof wearableConnectionsTable.$inferSelect,
  retryOpts: FetchWithRetryOpts = {},
): Promise<WearableSyncResult> {
  if (!conn.accessToken) {
    return { synced: false, message: "Whoop access token missing — please reconnect." };
  }
  const accessToken = await ensureFreshAccessToken(conn);
  if (!accessToken) {
    return { synced: false, message: "Whoop token refresh failed — please reconnect." };
  }
  // Pull last 7 days of recovery + sleep records
  const start = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  try {
    const [recRes, sleepRes] = await Promise.all([
      fetchWithRetry(`https://api.prod.whoop.com/developer/v1/recovery?start=${encodeURIComponent(start)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, retryOpts),
      fetchWithRetry(`https://api.prod.whoop.com/developer/v1/activity/sleep?start=${encodeURIComponent(start)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, retryOpts),
    ]);
    if (recRes.status === 401 || recRes.status === 403 || sleepRes.status === 401 || sleepRes.status === 403) {
      const failing = recRes.status === 401 || recRes.status === 403 ? recRes.status : sleepRes.status;
      await markConnectionNeedsReauth(userId, "whoop", `whoop API HTTP ${failing}`);
      return { synced: false, message: "Whoop authorization expired — please reconnect." };
    }
    if (!recRes.ok) return { synced: false, message: `Whoop recovery returned HTTP ${recRes.status}` };

    const recovery = (await recRes.json()) as { records?: Array<{ score?: { recovery_score?: number; resting_heart_rate?: number; hrv_rmssd_milli?: number }; created_at?: string }> };
    const sleep = sleepRes.ok ? (await sleepRes.json()) as { records?: Array<{ score?: { sleep_performance_percentage?: number; stage_summary?: { total_in_bed_time_milli?: number; total_awake_time_milli?: number } }; start?: string }> } : { records: [] };

    let upserted = 0;
    for (const rec of recovery.records ?? []) {
      const date = rec.created_at ? rec.created_at.slice(0, 10) : null;
      if (!date) continue;
      const matchSleep = (sleep.records ?? []).find(s => s.start?.slice(0, 10) === date);
      const sleepMs = (matchSleep?.score?.stage_summary?.total_in_bed_time_milli ?? 0) - (matchSleep?.score?.stage_summary?.total_awake_time_milli ?? 0);
      await upsertWellnessMetric({
        userId,
        metricDate: date,
        source: "whoop",
        readinessScore: rec.score?.recovery_score ?? null,
        restingHr: rec.score?.resting_heart_rate ?? null,
        hrvMs: rec.score?.hrv_rmssd_milli != null ? rec.score.hrv_rmssd_milli.toFixed(1) : null,
        sleepMinutes: sleepMs > 0 ? Math.round(sleepMs / 60000) : null,
        sleepScore: matchSleep?.score?.sleep_performance_percentage ?? null,
      });
      upserted++;
    }
    await db.update(wearableConnectionsTable)
      .set({ lastSyncAt: new Date(), updatedAt: new Date() })
      .where(and(eq(wearableConnectionsTable.userId, userId), eq(wearableConnectionsTable.provider, "whoop")));
    return { synced: true, message: `Synced ${upserted} day(s) of Whoop recovery & sleep.`, activities: upserted };
  } catch (err) {
    logger.error({ err, userId }, "[wearables] Whoop sync error");
    return { synced: false, message: "Whoop sync failed. Please reconnect your account." };
  }
}

// ── Google Fit OAuth + wellness pull ──────────────────────────────────────────

export function getGoogleFitOAuthUrl(userId: number, baseUrl: string): OAuthInitResult | { error: string } {
  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  if (!clientId) {
    return { error: "Google Fit integration not configured. Please contact your club administrator." };
  }
  const state = createOAuthState(userId);
  const callbackUrl = encodeURIComponent(`${baseUrl}/api/portal/wearables/google_fit/callback`);
  // Read-only scopes for sleep, activity, heart-rate metrics.
  const scope = encodeURIComponent([
    "https://www.googleapis.com/auth/fitness.activity.read",
    "https://www.googleapis.com/auth/fitness.sleep.read",
    "https://www.googleapis.com/auth/fitness.heart_rate.read",
  ].join(" "));
  const url = `https://accounts.google.com/o/oauth2/v2/auth`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&response_type=code`
    + `&scope=${scope}`
    + `&access_type=offline`
    + `&prompt=consent`
    + `&redirect_uri=${callbackUrl}`
    + `&state=${state}`;
  return { url, state };
}

export async function handleGoogleFitCallback(
  code: string,
  state: string,
  sessionUserId: number,
  baseUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const statePayload = verifyOAuthState(state);
  if (!statePayload) return { ok: false, error: "Invalid or expired OAuth state — please restart the connection process" };
  if (statePayload.userId !== sessionUserId) return { ok: false, error: "State userId mismatch — possible CSRF attempt" };
  const userId = sessionUserId;

  if (!isTokenEncryptionAvailable()) {
    return { ok: false, error: "Wearable token encryption is not configured — set WEARABLE_TOKEN_ENC_KEY or SESSION_SECRET" };
  }

  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "Google Fit credentials not configured" };

  try {
    // Use fetchWithRetry so a transient 5xx / 429 from Google's OAuth host
    // doesn't drop the user back at the connect screen mid-flow (Task #987).
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/portal/wearables/google_fit/callback`,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[wearables] Google Fit token exchange failed");
      return { ok: false, error: `Google Fit returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    const accessToken = encryptToken(data.access_token ?? "");
    const refreshToken = data.refresh_token ? encryptToken(data.refresh_token) : null;
    const tokenExpiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "google_fit",
      status: "connected",
      accessToken,
      refreshToken,
      tokenExpiresAt,
      connectedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
      set: { status: "connected", accessToken, refreshToken, tokenExpiresAt, connectedAt: new Date(), updatedAt: new Date() },
    });
    return { ok: true };
  } catch (err: unknown) {
    logger.error({ err }, "[wearables] Google Fit callback error");
    return { ok: false, error: String(err) };
  }
}

async function syncGoogleFitWellness(
  userId: number,
  conn: typeof wearableConnectionsTable.$inferSelect,
  retryOpts: FetchWithRetryOpts = {},
): Promise<WearableSyncResult> {
  if (!conn.accessToken) {
    return { synced: false, message: "Google Fit access token missing — please reconnect." };
  }
  const accessToken = await ensureFreshAccessToken(conn);
  if (!accessToken) {
    return { synced: false, message: "Google Fit token refresh failed — please reconnect." };
  }
  // Pull aggregated step counts for the last 7 days using the Fitness REST API.
  const endMs = Date.now();
  const startMs = endMs - 7 * 86400 * 1000;
  try {
    const res = await fetchWithRetry("https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: "com.google.step_count.delta" }],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: startMs,
        endTimeMillis: endMs,
      }),
    }, retryOpts);
    if (res.status === 401 || res.status === 403) {
      await markConnectionNeedsReauth(userId, "google_fit", `aggregate HTTP ${res.status}`);
      return { synced: false, message: "Google Fit authorization expired — please reconnect." };
    }
    if (!res.ok) return { synced: false, message: `Google Fit returned HTTP ${res.status}` };
    const data = (await res.json()) as { bucket?: Array<{ startTimeMillis?: string; dataset?: Array<{ point?: Array<{ value?: Array<{ intVal?: number }> }> }> }> };
    let upserted = 0;
    for (const bucket of data.bucket ?? []) {
      const startMillis = Number(bucket.startTimeMillis ?? 0);
      if (!startMillis) continue;
      const date = new Date(startMillis).toISOString().slice(0, 10);
      let steps = 0;
      for (const ds of bucket.dataset ?? []) {
        for (const pt of ds.point ?? []) {
          for (const v of pt.value ?? []) steps += v.intVal ?? 0;
        }
      }
      if (steps === 0) continue;
      await upsertWellnessMetric({
        userId,
        metricDate: date,
        source: "google_fit",
        steps,
      });
      upserted++;
    }
    await db.update(wearableConnectionsTable)
      .set({ lastSyncAt: new Date(), updatedAt: new Date() })
      .where(and(eq(wearableConnectionsTable.userId, userId), eq(wearableConnectionsTable.provider, "google_fit")));
    return { synced: true, message: `Synced ${upserted} day(s) of Google Fit activity.`, activities: upserted };
  } catch (err) {
    logger.error({ err, userId }, "[wearables] Google Fit sync error");
    return { synced: false, message: "Google Fit sync failed. Please reconnect your account." };
  }
}

/**
 * Latest result of {@link sweepWellnessConnections}, surfaced to operators via
 * the admin dashboard. Persisted to `wellness_sweep_runs` so the tile renders
 * immediately after a server restart instead of going blank for up to ~60 min
 * until the next hourly sweep ticks. We also keep an in-process cache so the
 * common admin-poll path doesn't hit the DB on every request.
 */
export interface WellnessSweepStatus {
  attempted: number;
  succeeded: number;
  needsReauth: number;
  ranAt: string; // ISO timestamp
  alerted: boolean;
}

let _lastWellnessSweepResult: WellnessSweepStatus | null = null;
let _lastWellnessSweepCacheLoaded = false;

/**
 * Test-only hook: forget the in-memory cache so the next call to
 * {@link getLastWellnessSweepResult} re-reads from the database. Used by the
 * "survives a server restart" test to simulate a fresh process.
 */
export function _resetWellnessSweepCacheForTests(): void {
  _lastWellnessSweepResult = null;
  _lastWellnessSweepCacheLoaded = false;
}

function rowToStatus(row: typeof wellnessSweepRunsTable.$inferSelect): WellnessSweepStatus {
  return {
    attempted: row.attempted,
    succeeded: row.succeeded,
    needsReauth: row.needsReauth,
    ranAt: row.ranAt.toISOString(),
    alerted: row.alerted,
  };
}

/**
 * Returns the most recent wellness-sweep result. Reads from the in-process
 * cache first; on a cold start (e.g. right after a restart) hydrates the cache
 * from the `wellness_sweep_runs` table so the admin tile is populated before
 * the next hourly sweep runs.
 */
export async function getLastWellnessSweepResult(): Promise<WellnessSweepStatus | null> {
  if (_lastWellnessSweepCacheLoaded) return _lastWellnessSweepResult;
  try {
    const [row] = await db.select()
      .from(wellnessSweepRunsTable)
      .orderBy(desc(wellnessSweepRunsTable.ranAt))
      .limit(1);
    _lastWellnessSweepResult = row ? rowToStatus(row) : null;
  } catch (err) {
    logger.warn({ err }, "[wearables] failed to hydrate last wellness sweep result from DB");
    _lastWellnessSweepResult = null;
  }
  _lastWellnessSweepCacheLoaded = true;
  return _lastWellnessSweepResult;
}

/**
 * Returns up to `days` days of recent wellness-sweep runs (most recent first),
 * for the admin dashboard's short trend view. Defaults to 30 days.
 */
export async function getWellnessSweepHistory(days = 30): Promise<WellnessSweepStatus[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.select()
    .from(wellnessSweepRunsTable)
    .where(gte(wellnessSweepRunsTable.ranAt, cutoff))
    .orderBy(desc(wellnessSweepRunsTable.ranAt));
  return rows.map(rowToStatus);
}

/** Retention horizon for `wellness_sweep_runs` — older rows are pruned on insert. */
const WELLNESS_SWEEP_RETENTION_DAYS = 90;

/**
 * Default alert thresholds for needs_reauth spikes during the wellness sweep.
 * These match the legacy hardcoded values: alert when EITHER the absolute
 * count is large (≥ 5) OR the share of attempted connections that flipped
 * is ≥ 25 % (with at least 4 attempts to avoid noisy alerts on tiny
 * samples).
 *
 * Task #850 — Per-organization overrides live on the `organizations` row
 * (`wearable_reauth_alert_min_count`, `_min_share_pct`, `_min_attempted`,
 * `_email`). Larger clubs can raise the absolute floor; smaller clubs can
 * lower it to be alerted on any flip. Connections owned by a user with
 * no `organizationId` (e.g. test fixtures) keep the legacy defaults.
 *
 * The `WELLNESS_REAUTH_ALERT_EMAIL` env var (optional) is used as a
 * fallback recipient when an org has not configured one of its own; the
 * structured warn-level log fires unconditionally so a log-based alerting
 * system can pick it up.
 */
export const WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT = 5;
export const WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT = 25;
export const WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED = 4;

interface OrgReauthAlertSettings {
  minCount: number;
  minSharePct: number;
  minAttempted: number;
  email: string | null;
}

const DEFAULT_REAUTH_ALERT_SETTINGS: OrgReauthAlertSettings = {
  minCount: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT,
  minSharePct: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT,
  minAttempted: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED,
  email: null,
};

/**
 * Background sweep: pull the latest 7 days of wellness data for every connected
 * Whoop and Google Fit account that hasn't synced in the last 24 hours.
 * Refreshes OAuth tokens proactively (within 5 min of expiry) and flips the
 * connection to status="needs_reauth" on persistent 401/403 failures so the
 * mobile app can prompt the user to reconnect.
 *
 * Designed to be called from the cron scheduler hourly; the 24h dedupe ensures
 * each account is actually swept at most once per day.
 *
 * Emits a warn-level alert log (and optional ops email) when the number of
 * connections flipped to needs_reauth exceeds an absolute or proportional
 * threshold, so a provider credential rotation doesn't go unnoticed until
 * players complain.
 */
export interface SweepOptions extends FetchWithRetryOpts {
  /**
   * Maximum number of in-flight requests per upstream provider. Defaults to 3
   * — keeps backlogs (e.g. after an outage) from bursting providers like
   * Whoop / Google Fit and tripping their rate limits.
   */
  perProviderConcurrency?: number;
}

export async function sweepWellnessConnections(opts: SweepOptions = {}): Promise<{
  attempted: number;
  succeeded: number;
  needsReauth: number;
}> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const due = await db.select()
    .from(wearableConnectionsTable)
    .where(and(
      eq(wearableConnectionsTable.status, "connected"),
      sql`${wearableConnectionsTable.provider} IN ('whoop', 'google_fit')`,
      sql`(${wearableConnectionsTable.lastSyncAt} IS NULL OR ${wearableConnectionsTable.lastSyncAt} < ${cutoff})`,
    ));

  const perProviderConcurrency = Math.max(1, opts.perProviderConcurrency ?? 3);
  // Pull retry knobs out so we can forward them to fetchWithRetry untouched.
  const { perProviderConcurrency: _ignored, ...retryOpts } = opts;
  void _ignored;

  // Group due connections by upstream provider so each provider gets its own
  // concurrency budget — one slow provider can't starve the other.
  const buckets = new Map<string, typeof due>();
  for (const conn of due) {
    const arr = buckets.get(conn.provider) ?? [];
    arr.push(conn);
    buckets.set(conn.provider, arr);
  }

  let succeeded = 0;
  let needsReauth = 0;

  const syncOne = async (conn: typeof due[number]) => {
    try {
      let result: WearableSyncResult;
      if (conn.provider === "whoop") {
        result = await syncWhoopWellness(conn.userId, conn, retryOpts);
      } else if (conn.provider === "google_fit") {
        result = await syncGoogleFitWellness(conn.userId, conn, retryOpts);
      } else {
        // Defensive: the SQL filter above already restricts providers, but
        // fall back to the generic dispatcher for any future additions.
        result = await syncWearableData(conn.userId, conn.provider as WearableProvider);
      }
      if (result.synced) succeeded++;
      // Re-read status to detect a flip to needs_reauth during the sync
      const [post] = await db.select({ status: wearableConnectionsTable.status })
        .from(wearableConnectionsTable)
        .where(and(
          eq(wearableConnectionsTable.userId, conn.userId),
          eq(wearableConnectionsTable.provider, conn.provider),
        ));
      if (post?.status === "needs_reauth") needsReauth++;
    } catch (err) {
      logger.warn({ err, userId: conn.userId, provider: conn.provider }, "[wearables] sweep sync error");
    }
  };

  // Run each provider's bucket in parallel, but each bucket is internally
  // capped at perProviderConcurrency.
  await Promise.all(
    Array.from(buckets.entries()).map(([, conns]) =>
      runWithConcurrency(conns, perProviderConcurrency, syncOne),
    ),
  );

  const attempted = due.length;

  // Task #850 — Evaluate alert thresholds per organization. Each user's
  // organizationId determines which org's thresholds apply; users with no
  // org fall back to the legacy defaults. We aggregate (attempted,
  // needsReauth) per org, then evaluate that org's configured thresholds.
  const dueUserIds = Array.from(new Set(due.map(c => c.userId)));
  const userOrgRows = dueUserIds.length === 0 ? [] : await db
    .select({ id: appUsersTable.id, organizationId: appUsersTable.organizationId })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, dueUserIds));
  const userOrgMap = new Map<number, number | null>();
  for (const row of userOrgRows) userOrgMap.set(row.id, row.organizationId ?? null);

  const orgIdsInSweep = Array.from(new Set(
    Array.from(userOrgMap.values()).filter((v): v is number => v !== null),
  ));
  const orgSettingsMap = new Map<number, OrgReauthAlertSettings>();
  if (orgIdsInSweep.length > 0) {
    const settingsRows = await db
      .select({
        id: organizationsTable.id,
        minCount: organizationsTable.wearableReauthAlertMinCount,
        minSharePct: organizationsTable.wearableReauthAlertMinSharePct,
        minAttempted: organizationsTable.wearableReauthAlertMinAttempted,
        email: organizationsTable.wearableReauthAlertEmail,
      })
      .from(organizationsTable)
      .where(inArray(organizationsTable.id, orgIdsInSweep));
    for (const row of settingsRows) {
      orgSettingsMap.set(row.id, {
        minCount: row.minCount,
        minSharePct: row.minSharePct,
        minAttempted: row.minAttempted,
        email: row.email ?? null,
      });
    }
  }

  // Per-org tallies: attempted + needsReauth, plus a recompute of the
  // post-sync status for each connection so we can attribute flips to
  // the right org without re-querying.
  type OrgKey = number | "no-org";
  const orgTallies = new Map<OrgKey, { attempted: number; needsReauth: number }>();
  const bumpAttempted = (key: OrgKey) => {
    const t = orgTallies.get(key) ?? { attempted: 0, needsReauth: 0 };
    t.attempted++;
    orgTallies.set(key, t);
  };
  for (const conn of due) {
    const orgId = userOrgMap.get(conn.userId) ?? null;
    bumpAttempted(orgId === null ? "no-org" : orgId);
  }

  // Re-read needs_reauth flips so we can attribute them per-org. We
  // already know the global needsReauth count from the sync loop above,
  // but we need the per-user breakdown for threshold evaluation.
  if (needsReauth > 0 && due.length > 0) {
    const flippedRows = await db.select({
      userId: wearableConnectionsTable.userId,
      provider: wearableConnectionsTable.provider,
    }).from(wearableConnectionsTable).where(and(
      inArray(wearableConnectionsTable.userId, dueUserIds),
      eq(wearableConnectionsTable.status, "needs_reauth"),
      sql`${wearableConnectionsTable.provider} IN ('whoop', 'google_fit')`,
    ));
    const flippedSet = new Set(flippedRows.map(r => `${r.userId}:${r.provider}`));
    for (const conn of due) {
      if (flippedSet.has(`${conn.userId}:${conn.provider}`)) {
        const orgId = userOrgMap.get(conn.userId) ?? null;
        const key: OrgKey = orgId === null ? "no-org" : orgId;
        const t = orgTallies.get(key) ?? { attempted: 0, needsReauth: 0 };
        t.needsReauth++;
        orgTallies.set(key, t);
      }
    }
  }

  // Evaluate each org's thresholds and emit per-org alerts.
  const fallbackEmail = process.env.WELLNESS_REAUTH_ALERT_EMAIL ?? null;
  let anyAlerted = false;
  for (const [key, tally] of orgTallies.entries()) {
    if (tally.needsReauth === 0) continue;
    const settings: OrgReauthAlertSettings = key === "no-org"
      ? DEFAULT_REAUTH_ALERT_SETTINGS
      : (orgSettingsMap.get(key) ?? DEFAULT_REAUTH_ALERT_SETTINGS);

    const sharePct = tally.attempted > 0 ? (tally.needsReauth / tally.attempted) * 100 : 0;
    const tripsCount = tally.needsReauth >= settings.minCount;
    const tripsShare =
      tally.attempted >= settings.minAttempted &&
      sharePct >= settings.minSharePct;
    const orgAlerted = tripsCount || tripsShare;
    if (!orgAlerted) continue;
    anyAlerted = true;

    const orgId = key === "no-org" ? null : key;
    logger.warn(
      {
        organizationId: orgId,
        attempted: tally.attempted,
        needsReauth: tally.needsReauth,
        sharePct: Math.round(sharePct),
        thresholdCount: settings.minCount,
        thresholdSharePct: settings.minSharePct,
        thresholdMinAttempted: settings.minAttempted,
      },
      "[wearables] wellness sweep alert: many wearable connections need re-auth — likely a provider credential rotation",
    );

    const recipient = settings.email ?? fallbackEmail;
    if (recipient) {
      try {
        const { sendBroadcastEmail } = await import("./mailer");
        const orgLabel = orgId === null ? "(unassigned users)" : `organization #${orgId}`;
        const body =
          `The hourly wellness sweep flipped ${tally.needsReauth} wearable connection(s) to needs_reauth ` +
          `for ${orgLabel} (out of ${tally.attempted} attempted, ${Math.round(sharePct)}%).\n\n` +
          `This usually indicates a Whoop or Google Fit credential rotation has invalidated ` +
          `existing tokens, and players will need to reconnect their wearable in the app.\n\n` +
          `Threshold (configured for this org): ≥${settings.minCount} connection(s) OR ` +
          `≥${settings.minSharePct}% of attempted (with at least ${settings.minAttempted} attempts).\n\n` +
          `Sweep ran at ${new Date().toISOString()}.`;
        await sendBroadcastEmail(
          recipient,
          "Operations",
          `[KHARAGOLF] Wearable re-auth spike: ${tally.needsReauth} connection(s) flipped`,
          body,
          "KHARAGOLF",
        );
      } catch (err) {
        logger.warn({ err, organizationId: orgId }, "[wearables] failed to send wellness sweep alert email");
      }
    }
  }

  const alerted = anyAlerted;

  logger.info({ attempted, succeeded, needsReauth, perProviderConcurrency }, "[wearables] wellness sweep complete");

  const ranAt = new Date();
  const status: WellnessSweepStatus = {
    attempted,
    succeeded,
    needsReauth,
    ranAt: ranAt.toISOString(),
    alerted,
  };

  // Persist the run so the admin tile survives a server restart and so we
  // can render a short trend chart. Failure to persist is logged but never
  // blocks the sweep — the in-memory cache is still updated.
  try {
    await db.insert(wellnessSweepRunsTable).values({
      ranAt,
      attempted,
      succeeded,
      needsReauth,
      alerted,
    });
    // Prune rows older than the retention horizon so the table stays bounded.
    const pruneCutoff = new Date(Date.now() - WELLNESS_SWEEP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(wellnessSweepRunsTable)
      .where(lt(wellnessSweepRunsTable.ranAt, pruneCutoff));
  } catch (err) {
    logger.warn({ err }, "[wearables] failed to persist wellness sweep run");
  }

  _lastWellnessSweepResult = status;
  _lastWellnessSweepCacheLoaded = true;

  return { attempted, succeeded, needsReauth };
}

// ── Weekly week-over-week needs_reauth drift alert (Task #1151) ──────────────
//
// The hourly sweep alert above only fires on an absolute spike (≥ minCount
// flips OR ≥ minSharePct% of attempted in a single run). Slow drift —
// e.g. tokens silently expiring a few extra per day for a week — never trips
// the absolute threshold, but is visible on the sweep-history chart.
//
// This evaluator compares the average `needs_reauth` count over the most
// recent 7 days against the prior 7 days from `wellness_sweep_runs`, and
// emails each org's configured wearable-reauth alert recipient when the
// week-over-week increase exceeds a configurable threshold. Rate-limited to
// at most once per 7 days per org via an atomic conditional UPDATE on
// `organizations.wearable_reauth_wow_alert_last_sent_at`.

/**
 * Default minimum week-over-week increase in average `needs_reauth` per
 * sweep run that triggers the drift alert. Defaults to 1.0, i.e. the
 * recent week is averaging at least 1 more flip per sweep than the prior
 * week. Tunable globally via env `WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA`,
 * and per-org via `organizations.wearable_reauth_wow_alert_min_delta`
 * (Task #1325) — the per-org override takes precedence when set.
 */
export const WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA = 1.0;

/**
 * Default minimum number of sweep runs required in EACH window before we
 * trust the average enough to alert. Tunable via env
 * `WELLNESS_REAUTH_WOW_ALERT_MIN_RUNS`. Defaults to 24 — about a day's worth
 * of hourly sweeps — so a freshly-deployed cluster doesn't fire on a single
 * outlier run.
 */
export const WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_RUNS = 24;

export interface WeeklyReauthDriftWindow {
  runs: number;
  averageNeedsReauth: number;
  totalNeedsReauth: number;
}

export interface WeeklyReauthDriftResult {
  evaluatedAt: string;
  thisWeek: WeeklyReauthDriftWindow;
  lastWeek: WeeklyReauthDriftWindow;
  delta: number;
  threshold: number;
  minRuns: number;
  tripped: boolean;
  reason: string | null;
  orgsNotified: number;
  orgsRateLimited: number;
}

/**
 * Aggregate `wellness_sweep_runs` rows in the half-open window
 * [start, end) into a {runs, averageNeedsReauth, totalNeedsReauth} tuple.
 *
 * Exported so the admin dashboard's drift snapshot endpoint (Task #1324)
 * can reuse the exact same window math the cron evaluator uses, instead of
 * reimplementing it on the read path.
 */
export async function aggregateSweepWindow(
  start: Date,
  end: Date,
): Promise<WeeklyReauthDriftWindow> {
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${wellnessSweepRunsTable.needsReauth}), 0)::int`,
      avg: sql<number>`coalesce(avg(${wellnessSweepRunsTable.needsReauth}), 0)::float`,
    })
    .from(wellnessSweepRunsTable)
    .where(and(
      gte(wellnessSweepRunsTable.ranAt, start),
      lt(wellnessSweepRunsTable.ranAt, end),
    ));
  return {
    runs: Number(row?.runs ?? 0),
    averageNeedsReauth: Number(row?.avg ?? 0),
    totalNeedsReauth: Number(row?.total ?? 0),
  };
}

/**
 * Compute week-over-week drift in average `needs_reauth` and, when the
 * configured threshold is exceeded, email each org's wearable-reauth alert
 * recipient. The alert is rate-limited to once per 7 days per org via an
 * atomic conditional UPDATE on `wearable_reauth_wow_alert_last_sent_at`.
 *
 * Returns a structured result so the cron logger and the integration tests
 * can assert what happened without scraping log lines.
 *
 * Behaviour:
 *   - Both windows must have ≥ `minRuns` rows; otherwise the call is a
 *     no-op (`reason="insufficient_data"`).
 *   - The drift alert fires when `(thisWeek.avg - lastWeek.avg) >= threshold`.
 *   - For each org with a configured `wearable_reauth_alert_email` (or
 *     when none, the global `WELLNESS_REAUTH_ALERT_EMAIL` env fallback),
 *     attempt to claim the per-org weekly slot. Orgs whose watermark is
 *     within the last 7 days are skipped (rate-limited).
 */
export async function evaluateWeeklyReauthDrift(
  options: { now?: Date } = {},
): Promise<WeeklyReauthDriftResult> {
  const now = options.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const thisStart = new Date(now.getTime() - 7 * day);
  const lastStart = new Date(now.getTime() - 14 * day);

  // System-wide default threshold (env > hardcoded). Per-org rows may
  // override this via `wearable_reauth_wow_alert_min_delta` (Task #1325);
  // orgs with no override (or whose override fails to parse) fall back
  // to this value when their notification decision is computed below.
  const threshold = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
  })();
  const minRuns = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_RUNS;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_RUNS;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_RUNS;
  })();

  const [thisWeek, lastWeek] = await Promise.all([
    aggregateSweepWindow(thisStart, now),
    aggregateSweepWindow(lastStart, thisStart),
  ]);
  const delta = thisWeek.averageNeedsReauth - lastWeek.averageNeedsReauth;

  const baseResult: WeeklyReauthDriftResult = {
    evaluatedAt: now.toISOString(),
    thisWeek,
    lastWeek,
    delta,
    threshold,
    minRuns,
    tripped: false,
    reason: null,
    orgsNotified: 0,
    orgsRateLimited: 0,
  };

  if (thisWeek.runs < minRuns || lastWeek.runs < minRuns) {
    return { ...baseResult, reason: "insufficient_data" };
  }

  // Per-org evaluation — Task #1325. Each org may override the drift
  // threshold via `wearable_reauth_wow_alert_min_delta`; we cannot short
  // circuit on the global threshold here because an org with a *lower*
  // override may still need to be alerted even when the system-wide
  // default is not exceeded.
  const fallbackEmail = process.env.WELLNESS_REAUTH_ALERT_EMAIL ?? null;

  // Pull every org with a configured recipient. Orgs without a recipient are
  // skipped here; the fallback env var is used as a *single* extra recipient
  // attached to a synthetic "no-org" slot so a global ops alias still gets
  // notified even when no org has set its own.
  const orgs = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      email: organizationsTable.wearableReauthAlertEmail,
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
      minDeltaRaw: organizationsTable.wearableReauthWowAlertMinDelta,
    })
    .from(organizationsTable)
    .where(isNotNull(organizationsTable.wearableReauthAlertEmail));

  let orgsNotified = 0;
  let orgsRateLimited = 0;
  let anyOrgTripped = false;
  const rateLimitCutoff = new Date(now.getTime() - 7 * day);

  for (const org of orgs) {
    if (!org.email) continue;

    // Per-org override. drizzle returns numeric() columns as strings, so
    // parse + validate before use; fall back to the system-wide default
    // (env var or 1.0) on null/empty/non-positive/non-finite values so a
    // bad row never silently disables alerting.
    const orgThreshold = (() => {
      const raw = org.minDeltaRaw;
      if (raw == null || raw === "") return threshold;
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) && n > 0 ? n : threshold;
    })();

    if (delta < orgThreshold) continue; // this org's threshold not met
    anyOrgTripped = true;

    // Atomic claim of the weekly slot — only one cron tick per 7 days per org
    // succeeds. The conditional UPDATE both protects against duplicate sends
    // when this evaluator runs more than once per week and is robust to
    // multiple cron processes racing.
    const claimed = await db
      .update(organizationsTable)
      .set({ wearableReauthWowAlertLastSentAt: now, updatedAt: now })
      .where(and(
        eq(organizationsTable.id, org.id),
        sql`(${organizationsTable.wearableReauthWowAlertLastSentAt} IS NULL OR ${organizationsTable.wearableReauthWowAlertLastSentAt} < ${rateLimitCutoff})`,
      ))
      .returning({ id: organizationsTable.id });
    if (claimed.length === 0) {
      orgsRateLimited++;
      continue;
    }
    try {
      const { sendBroadcastEmail } = await import("./mailer");
      await sendBroadcastEmail(
        org.email,
        "Operations",
        `[KHARAGOLF] Wearable re-auth drifting up week-over-week`,
        buildWeeklyDriftEmailBody(org.name, thisWeek, lastWeek, delta, orgThreshold),
        "KHARAGOLF",
      );
      orgsNotified++;
    } catch (err) {
      logger.warn({ err, organizationId: org.id }, "[wearables] failed to send weekly reauth drift email");
      // Roll back the watermark so a later tick can retry this org.
      await db.update(organizationsTable)
        .set({ wearableReauthWowAlertLastSentAt: org.lastSentAt, updatedAt: now })
        .where(eq(organizationsTable.id, org.id));
    }
  }

  // Fallback global recipient — only fires when NO org has configured a
  // recipient at all (i.e. a small dev/staging cluster). If any org is
  // configured (even if rate-limited on this tick), we suppress the
  // fallback so the global ops alias isn't re-spammed every day while at
  // least one org is sitting inside its 7-day window. Uses the system
  // default threshold since there's no per-org override to apply.
  if (orgs.length === 0 && fallbackEmail && delta >= threshold) {
    anyOrgTripped = true;
    try {
      const { sendBroadcastEmail } = await import("./mailer");
      await sendBroadcastEmail(
        fallbackEmail,
        "Operations",
        `[KHARAGOLF] Wearable re-auth drifting up week-over-week`,
        buildWeeklyDriftEmailBody(null, thisWeek, lastWeek, delta, threshold),
        "KHARAGOLF",
      );
      orgsNotified = 1;
    } catch (err) {
      logger.warn({ err }, "[wearables] failed to send fallback weekly reauth drift email");
    }
  }

  if (!anyOrgTripped) {
    return { ...baseResult, reason: "below_threshold" };
  }

  logger.warn({
    thisAvg: Math.round(thisWeek.averageNeedsReauth * 100) / 100,
    lastAvg: Math.round(lastWeek.averageNeedsReauth * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    threshold,
    orgsNotified,
    orgsRateLimited,
  }, "[wearables] weekly needs_reauth drift alert: this week's average exceeds last week's by the configured threshold");

  return { ...baseResult, tripped: true, orgsNotified, orgsRateLimited };
}

// ── Read-only WoW drift snapshot for the admin dashboard (Task #1324) ────────
//
// The cron evaluator above emails admins when needs_reauth quietly creeps up
// week-over-week. Admins also want to see the same signal at a glance in the
// dashboard rather than waiting for an email, so this helper returns the same
// {thisWeek, lastWeek, delta, threshold} numbers without sending anything,
// plus the per-org rate-limit watermark and the next eligible alert time.
//
// Reuses `aggregateSweepWindow` and the same threshold/min-runs env knobs as
// the cron path so the dashboard can never disagree with the email.

/** Number of days in each comparison window (this week / prior week). */
export const WELLNESS_REAUTH_WOW_WINDOW_DAYS = 7;
/** Per-org rate-limit window for the WoW drift alert email. */
export const WELLNESS_REAUTH_WOW_RATE_LIMIT_DAYS = 7;
/**
 * Trailing window over which we count Acknowledge / snooze clicks per org
 * to enforce the runaway-snooze cap (Task #1970). Hard-coded at 30 days to
 * match the language on the dashboard banner ("snoozed K times in the last
 * 30 days") and the error message the API returns.
 */
export const WELLNESS_REAUTH_WOW_SNOOZE_COUNT_WINDOW_DAYS = 30;
/**
 * Default cap on Acknowledge / snooze clicks per org per 30 days
 * (Task #1970). Override at runtime via the
 * WELLNESS_REAUTH_WOW_MAX_SNOOZES_PER_30D env var. Five clicks is a
 * generous ceiling — a legitimate persistent drift would normally be
 * resolved (or escalated) well before five admin snoozes accumulate, so
 * crossing this line strongly suggests the alert is being silenced
 * indefinitely instead of being addressed.
 */
export const WELLNESS_REAUTH_WOW_DEFAULT_MAX_SNOOZES_PER_30D = 5;

/**
 * Resolve the per-org snooze cap from the environment, falling back to the
 * hard-coded default. Non-positive / non-integer values fall back too so a
 * misconfigured env knob can't silently disable the cap or, worse, set it
 * to zero and lock every admin out of the snooze button.
 */
export function getMaxSnoozesPer30d(): number {
  const raw = process.env.WELLNESS_REAUTH_WOW_MAX_SNOOZES_PER_30D;
  if (!raw) return WELLNESS_REAUTH_WOW_DEFAULT_MAX_SNOOZES_PER_30D;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_DEFAULT_MAX_SNOOZES_PER_30D;
}

export interface WeeklyReauthDriftOrgAcknowledgment {
  /** ISO timestamp of the most recent admin click on Acknowledge for this org. */
  acknowledgedAt: string;
  /** Snapshot of the acting admin's display name at click time. */
  acknowledgedByName: string | null;
  /** Snapshot of the acting admin's role at click time. */
  acknowledgedByRole: string | null;
  /** Snooze duration the admin chose, in days (1..30). */
  snoozeDays: number;
}

export interface WeeklyReauthDriftOrgWatermark {
  id: number;
  name: string | null;
  /** ISO timestamp of the last WoW alert email sent to this org, or null. */
  lastSentAt: string | null;
  /**
   * ISO timestamp at which the per-org rate limit (`lastSentAt + 7d`) lifts.
   * Null when no alert has ever been sent — the org is eligible immediately.
   */
  nextEligibleAt: string | null;
  /**
   * Most recent admin acknowledgement of the drift alert for this org, or
   * null when no admin has ever clicked Acknowledge. Drives the
   * "Acknowledged by X on Y" line under the dashboard tile (Task #1578).
   */
  lastAcknowledgment: WeeklyReauthDriftOrgAcknowledgment | null;
  /**
   * Number of Acknowledge / snooze clicks for this org in the trailing
   * `WELLNESS_REAUTH_WOW_SNOOZE_COUNT_WINDOW_DAYS` (30) days (Task #1970).
   * Surfaced so the dashboard can render a red "snoozed K times in the
   * last 30 days" banner once the cap is reached and so the acknowledge
   * endpoint can refuse further clicks before the snooze becomes a
   * permanent silencer.
   */
  snoozeCountLast30d: number;
  /**
   * Cap on Acknowledge / snooze clicks per org per 30 days (Task #1970).
   * The acknowledge endpoint refuses further clicks once
   * `snoozeCountLast30d >= maxSnoozesPer30d`. Exposed on the snapshot so
   * the UI's "snoozed K of N times" banner stays in sync with whatever
   * the env override is set to without hard-coding the number.
   */
  maxSnoozesPer30d: number;
}

export interface WeeklyReauthDriftSnapshot {
  evaluatedAt: string;
  windowDays: number;
  rateLimitDays: number;
  thisWeek: WeeklyReauthDriftWindow;
  lastWeek: WeeklyReauthDriftWindow;
  delta: number;
  threshold: number;
  minRuns: number;
  /** True when both windows have ≥ minRuns rows (otherwise the average is noisy). */
  hasSufficientData: boolean;
  /** True when delta ≥ threshold (i.e. the cron evaluator would fire). */
  exceedsThreshold: boolean;
  /** Per-org watermark, or null when the caller has no organization. */
  org: WeeklyReauthDriftOrgWatermark | null;
}

/** Read the same threshold + minRuns the cron path uses, from env or defaults. */
function readWeeklyReauthDriftConfig(): { threshold: number; minRuns: number } {
  const threshold = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
  })();
  const minRuns = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_RUNS;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_RUNS;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_RUNS;
  })();
  return { threshold, minRuns };
}

/**
 * Read-only sibling of `evaluateWeeklyReauthDrift` that powers the admin
 * dashboard tile. Returns the same window aggregates + threshold the cron
 * job uses, plus the org's per-week rate-limit watermark, without sending
 * any email or mutating any row.
 *
 * `orgId` is the caller's organization. When null (e.g. a super-admin not
 * scoped to an org), the org watermark slot is null and only the global
 * aggregates are returned.
 */
export async function getWeeklyReauthDriftSnapshot(
  orgId: number | null,
  options: { now?: Date } = {},
): Promise<WeeklyReauthDriftSnapshot> {
  const now = options.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const thisStart = new Date(now.getTime() - WELLNESS_REAUTH_WOW_WINDOW_DAYS * day);
  const lastStart = new Date(now.getTime() - 2 * WELLNESS_REAUTH_WOW_WINDOW_DAYS * day);

  const { threshold, minRuns } = readWeeklyReauthDriftConfig();

  // Trailing 30-day window over which we count snooze clicks for the
  // runaway-snooze cap (Task #1970). Computed up-front so both the count
  // query and the snapshot field use the exact same boundary.
  const snoozeCountWindowStart = new Date(
    now.getTime() - WELLNESS_REAUTH_WOW_SNOOZE_COUNT_WINDOW_DAYS * day,
  );

  const [thisWeek, lastWeek, orgRow, ackRow, snoozeCountRow] = await Promise.all([
    aggregateSweepWindow(thisStart, now),
    aggregateSweepWindow(lastStart, thisStart),
    orgId == null
      ? Promise.resolve(null)
      : db.select({
          id: organizationsTable.id,
          name: organizationsTable.name,
          lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
        }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).then(rows => rows[0] ?? null),
    // Most recent admin Acknowledge / snooze click for this org (Task #1578).
    // Drives the "Acknowledged by X on Y" line under the dashboard tile.
    orgId == null
      ? Promise.resolve(null)
      : db.select({
          createdAt: wearableReauthWowAcknowledgmentsTable.createdAt,
          acknowledgedByName: wearableReauthWowAcknowledgmentsTable.acknowledgedByName,
          acknowledgedByRole: wearableReauthWowAcknowledgmentsTable.acknowledgedByRole,
          snoozeDays: wearableReauthWowAcknowledgmentsTable.snoozeDays,
        }).from(wearableReauthWowAcknowledgmentsTable)
          .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId))
          .orderBy(desc(wearableReauthWowAcknowledgmentsTable.createdAt))
          .limit(1)
          .then(rows => rows[0] ?? null),
    // Count of Acknowledge / snooze clicks in the trailing 30 days for
    // this org (Task #1970). Drives the runaway-snooze banner + the
    // server-side cap on the acknowledge endpoint. Uses the existing
    // (organization_id, created_at) index for an O(log n) scan.
    orgId == null
      ? Promise.resolve(null)
      : db.select({ value: sql<number>`count(*)::int` })
          .from(wearableReauthWowAcknowledgmentsTable)
          .where(and(
            eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId),
            gte(wearableReauthWowAcknowledgmentsTable.createdAt, snoozeCountWindowStart),
          ))
          .then(rows => rows[0] ?? null),
  ]);

  const delta = thisWeek.averageNeedsReauth - lastWeek.averageNeedsReauth;
  const hasSufficientData = thisWeek.runs >= minRuns && lastWeek.runs >= minRuns;
  const exceedsThreshold = hasSufficientData && delta >= threshold;

  let org: WeeklyReauthDriftOrgWatermark | null = null;
  if (orgRow) {
    const lastSentAt = orgRow.lastSentAt ?? null;
    const nextEligibleAt = lastSentAt
      ? new Date(lastSentAt.getTime() + WELLNESS_REAUTH_WOW_RATE_LIMIT_DAYS * day)
      : null;
    const lastAcknowledgment: WeeklyReauthDriftOrgAcknowledgment | null = ackRow
      ? {
          acknowledgedAt: ackRow.createdAt.toISOString(),
          acknowledgedByName: ackRow.acknowledgedByName ?? null,
          acknowledgedByRole: ackRow.acknowledgedByRole ?? null,
          snoozeDays: ackRow.snoozeDays,
        }
      : null;
    // count(*) is non-nullable but the cast lands as `unknown` through
    // drizzle's sql<T> escape hatch — coerce defensively so a driver
    // returning a string (some pg drivers do for bigint) still becomes a
    // real number on the wire.
    const snoozeCountLast30d = snoozeCountRow ? Number(snoozeCountRow.value) || 0 : 0;
    org = {
      id: orgRow.id,
      name: orgRow.name ?? null,
      lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
      nextEligibleAt: nextEligibleAt ? nextEligibleAt.toISOString() : null,
      lastAcknowledgment,
      snoozeCountLast30d,
      maxSnoozesPer30d: getMaxSnoozesPer30d(),
    };
  }

  return {
    evaluatedAt: now.toISOString(),
    windowDays: WELLNESS_REAUTH_WOW_WINDOW_DAYS,
    rateLimitDays: WELLNESS_REAUTH_WOW_RATE_LIMIT_DAYS,
    thisWeek,
    lastWeek,
    delta,
    threshold,
    minRuns,
    hasSufficientData,
    exceedsThreshold,
    org,
  };
}

// ── Per-org acknowledgment history for the WoW drift tile (Task #1969) ───────
//
// `getWeeklyReauthDriftSnapshot` only surfaces the *most recent* admin
// snooze under the dashboard tile. Postmortems also want to see the trail
// behind that latest line — "did somebody silence this five times in a
// row?" — without dropping into the database. This helper returns the N
// most recent rows from `wearable_reauth_wow_acknowledgments` for a given
// org, newest-first, capped server-side so a hostile `?limit=999` can't
// pull the entire audit table over the wire.
//
// Read-only; no email is sent and no row is mutated. Callers in
// `routes/admin.ts` gate on the same role check the snapshot endpoint
// uses (org_admin / tournament_director / super_admin).

/** Default number of acknowledgment rows returned by the history helper. */
export const WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT = 20;
/**
 * Hard upper bound — matches the default. The task spec (#1969) caps the
 * disclosure at "the 20 most recent rows for the caller's org", so the
 * endpoint refuses to widen that even when `?limit=999` is hand-typed
 * into the URL. Anyone needing a deeper trail should query the audit
 * table directly.
 */
export const WELLNESS_REAUTH_WOW_ACK_HISTORY_MAX_LIMIT = 20;

export interface WeeklyReauthDriftAcknowledgmentEntry {
  /** ISO timestamp of the click. */
  acknowledgedAt: string;
  /** Snapshot of the acting admin's display name at click time, or null. */
  acknowledgedByName: string | null;
  /** Snapshot of the acting admin's role at click time, or null. */
  acknowledgedByRole: string | null;
  /** Snooze duration the admin chose, in days (1..30). */
  snoozeDays: number;
}

export interface WeeklyReauthDriftAcknowledgmentHistoryResult {
  /** ISO timestamp at which the read query ran. */
  evaluatedAt: string;
  /** The org whose acknowledgments are listed. */
  organizationId: number;
  /** The cap applied to the result set (after clamping to MAX_LIMIT). */
  limit: number;
  /** Newest-first list of acknowledgments, length ≤ `limit`. */
  entries: WeeklyReauthDriftAcknowledgmentEntry[];
}

/**
 * Read-only list of the N most recent admin acknowledgments / snoozes for
 * a given org's WoW drift alert, newest-first.
 *
 * `options.limit` is clamped to `[1, MAX_LIMIT]` (defaults to
 * `DEFAULT_LIMIT`). Non-integer / non-positive values fall back to the
 * default so a malformed query string never crashes the read path.
 */
export async function getWeeklyReauthDriftAcknowledgmentHistory(
  orgId: number,
  options: { now?: Date; limit?: number } = {},
): Promise<WeeklyReauthDriftAcknowledgmentHistoryResult> {
  const now = options.now ?? new Date();
  const limit = (() => {
    const raw = options.limit;
    // Non-integer / non-positive / non-finite values fall back to the
    // default rather than 4xx-ing — the disclosure should always render
    // *something* even if the caller hand-typed `?limit=1.5` or `?limit=abc`
    // into the URL bar.
    if (raw == null || !Number.isFinite(raw)) return WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT;
    if (!Number.isInteger(raw) || raw < 1) return WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT;
    return Math.min(raw, WELLNESS_REAUTH_WOW_ACK_HISTORY_MAX_LIMIT);
  })();

  const rows = await db
    .select({
      createdAt: wearableReauthWowAcknowledgmentsTable.createdAt,
      acknowledgedByName: wearableReauthWowAcknowledgmentsTable.acknowledgedByName,
      acknowledgedByRole: wearableReauthWowAcknowledgmentsTable.acknowledgedByRole,
      snoozeDays: wearableReauthWowAcknowledgmentsTable.snoozeDays,
    })
    .from(wearableReauthWowAcknowledgmentsTable)
    .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId))
    .orderBy(desc(wearableReauthWowAcknowledgmentsTable.createdAt))
    .limit(limit);

  return {
    evaluatedAt: now.toISOString(),
    organizationId: orgId,
    limit,
    entries: rows.map(r => ({
      acknowledgedAt: r.createdAt.toISOString(),
      acknowledgedByName: r.acknowledgedByName ?? null,
      acknowledgedByRole: r.acknowledgedByRole ?? null,
      snoozeDays: r.snoozeDays,
    })),
  };
}

// ── Weekly drift trend history for the admin dashboard chart (Task #1577) ────
//
// The WoW drift tile (Task #1324) only compares two adjacent 7-day windows.
// Admins also want to see whether a spike is a one-off blip or a persistent
// climb. This helper returns N consecutive non-overlapping 7-day buckets (one
// per week) of average needs_reauth, so the dashboard can render a small
// sparkline / bar chart with a threshold reference line.
//
// Reuses `aggregateSweepWindow` and the same threshold/min-runs env knobs as
// the cron path so the chart can never disagree with the email or the tile.

/** Default number of weekly buckets returned by the drift history helper. */
export const WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS = 8;
/** Lower bound — any fewer than this and the chart isn't useful. */
export const WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS = 2;
/** Upper bound — protects the read path from a hostile `?weeks=999`. */
export const WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS = 26;

export interface WeeklyReauthDriftHistoryBucket {
  /** ISO timestamp of the inclusive start of this 7-day bucket. */
  weekStart: string;
  /** ISO timestamp of the exclusive end of this 7-day bucket. */
  weekEnd: string;
  runs: number;
  averageNeedsReauth: number;
  totalNeedsReauth: number;
  /** True when this bucket has ≥ minRuns rows (i.e. its average is trustworthy). */
  hasSufficientData: boolean;
}

export interface WeeklyReauthDriftHistoryResult {
  evaluatedAt: string;
  windowDays: number;
  weeks: number;
  threshold: number;
  minRuns: number;
  /** Oldest-first list of weekly buckets, length === `weeks`. */
  buckets: WeeklyReauthDriftHistoryBucket[];
}

/**
 * Read-only N-week trend of average `needs_reauth` per sweep run.
 *
 * Buckets are non-overlapping 7-day windows ending at `now` (i.e. the last
 * bucket is identical to `getWeeklyReauthDriftSnapshot().thisWeek`, the
 * second-to-last is identical to its `lastWeek`, and so on). Returned
 * oldest-first so the UI can feed it directly into a chart's `data` prop
 * without reversing.
 *
 * `options.weeks` is clamped to `[MIN_WEEKS, MAX_WEEKS]` (defaults to
 * `DEFAULT_WEEKS`). Non-integer / non-positive values fall back to the
 * default so a malformed query string never crashes the read path.
 */
export async function getWeeklyReauthDriftHistory(
  options: { now?: Date; weeks?: number } = {},
): Promise<WeeklyReauthDriftHistoryResult> {
  const now = options.now ?? new Date();
  const weeks = (() => {
    const raw = options.weeks;
    if (raw == null || !Number.isFinite(raw)) return WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS;
    const n = Math.floor(raw);
    if (!Number.isInteger(n) || n <= 0) return WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS;
    if (n < WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS) return WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS;
    if (n > WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS) return WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS;
    return n;
  })();

  const day = 24 * 60 * 60 * 1000;
  const windowDays = WELLNESS_REAUTH_WOW_WINDOW_DAYS;
  const { threshold, minRuns } = readWeeklyReauthDriftConfig();

  // Bucket i (i=0 = oldest) covers
  //   [now - (weeks-i)*7d, now - (weeks-i-1)*7d).
  // The last bucket (i=weeks-1) ends at exactly `now`.
  const ranges: { start: Date; end: Date }[] = [];
  for (let i = 0; i < weeks; i++) {
    const end = new Date(now.getTime() - (weeks - 1 - i) * windowDays * day);
    const start = new Date(end.getTime() - windowDays * day);
    ranges.push({ start, end });
  }

  const aggregates = await Promise.all(
    ranges.map(r => aggregateSweepWindow(r.start, r.end)),
  );

  return {
    evaluatedAt: now.toISOString(),
    windowDays,
    weeks,
    threshold,
    minRuns,
    buckets: ranges.map((r, i) => ({
      weekStart: r.start.toISOString(),
      weekEnd: r.end.toISOString(),
      runs: aggregates[i].runs,
      averageNeedsReauth: aggregates[i].averageNeedsReauth,
      totalNeedsReauth: aggregates[i].totalNeedsReauth,
      hasSufficientData: aggregates[i].runs >= minRuns,
    })),
  };
}

function buildWeeklyDriftEmailBody(
  orgName: string | null,
  thisWeek: WeeklyReauthDriftWindow,
  lastWeek: WeeklyReauthDriftWindow,
  delta: number,
  threshold: number,
): string {
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
  const who = orgName ? `for ${orgName}` : `(global / unassigned)`;
  return (
    `The weekly wearable re-auth check ${who} shows a quiet upward drift in the number ` +
    `of player wearable connections silently expiring before the absolute spike alert ` +
    `would fire.\n\n` +
    `This week (last 7 days): average ${fmt(thisWeek.averageNeedsReauth)} needs_reauth flips per ` +
    `sweep across ${thisWeek.runs} runs (total ${thisWeek.totalNeedsReauth}).\n` +
    `Prior week:                average ${fmt(lastWeek.averageNeedsReauth)} flips per sweep across ` +
    `${lastWeek.runs} runs (total ${lastWeek.totalNeedsReauth}).\n` +
    `Week-over-week increase:   +${fmt(delta)} (configured threshold ≥ ${fmt(threshold)}).\n\n` +
    `This usually indicates a Whoop or Google Fit credential rotation has begun ` +
    `invalidating tokens; players will need to reconnect their wearable in the app. ` +
    `The sweep-history chart in the admin dashboard shows the per-day breakdown.\n\n` +
    `This alert is rate-limited to at most once per 7 days per organization.`
  );
}

// ── Wellness ingestion + readiness recommendation ─────────────────────────────

export interface WellnessMetricInput {
  userId: number;
  metricDate: string;
  source: WellnessProvider;
  readinessScore?: number | null;
  sleepMinutes?: number | null;
  sleepScore?: number | null;
  hrvMs?: string | number | null;
  restingHr?: number | null;
  steps?: number | null;
  activeCalories?: number | null;
  strainScore?: string | number | null;
  raw?: Record<string, unknown> | null;
}

/** Upsert a single (user, date, source) wellness metric row. */
export async function upsertWellnessMetric(input: WellnessMetricInput): Promise<void> {
  const values = {
    userId: input.userId,
    metricDate: input.metricDate,
    source: input.source,
    readinessScore: input.readinessScore ?? null,
    sleepMinutes: input.sleepMinutes ?? null,
    sleepScore: input.sleepScore ?? null,
    hrvMs: input.hrvMs != null ? String(input.hrvMs) : null,
    restingHr: input.restingHr ?? null,
    steps: input.steps ?? null,
    activeCalories: input.activeCalories ?? null,
    strainScore: input.strainScore != null ? String(input.strainScore) : null,
    raw: input.raw ?? null,
    updatedAt: new Date(),
  };
  await db.insert(wellnessDailyMetricsTable).values(values).onConflictDoUpdate({
    target: [wellnessDailyMetricsTable.userId, wellnessDailyMetricsTable.metricDate, wellnessDailyMetricsTable.source],
    set: {
      readinessScore: values.readinessScore,
      sleepMinutes: values.sleepMinutes,
      sleepScore: values.sleepScore,
      hrvMs: values.hrvMs,
      restingHr: values.restingHr,
      steps: values.steps,
      activeCalories: values.activeCalories,
      strainScore: values.strainScore,
      raw: values.raw,
      updatedAt: values.updatedAt,
    },
  });
}

export interface AggregatedWellnessDay {
  metricDate: string;
  readinessScore: number | null;
  sleepMinutes: number | null;
  sleepScore: number | null;
  hrvMs: number | null;
  restingHr: number | null;
  steps: number | null;
  sources: string[];
}

/**
 * Returns at most one row per date by merging across sources. Whoop wins for
 * readiness/HRV/recovery; Garmin/Apple Health/Google Fit fill in steps & sleep
 * when Whoop does not provide them. Sources used per day are listed for the UI.
 */
export async function getAggregatedWellnessDays(
  userId: number,
  days: number,
): Promise<AggregatedWellnessDay[]> {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(wellnessDailyMetricsTable)
    .where(and(eq(wellnessDailyMetricsTable.userId, userId), gte(wellnessDailyMetricsTable.metricDate, cutoff)))
    .orderBy(desc(wellnessDailyMetricsTable.metricDate));

  const SOURCE_PRIORITY: Record<string, number> = {
    whoop: 5, garmin: 4, apple_health: 3, google_fit: 2, manual: 1,
  };

  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDate.has(r.metricDate)) byDate.set(r.metricDate, []);
    byDate.get(r.metricDate)!.push(r);
  }

  const out: AggregatedWellnessDay[] = [];
  for (const [date, dayRows] of byDate) {
    dayRows.sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));
    const pick = <K extends keyof typeof dayRows[number]>(k: K) => {
      for (const r of dayRows) if (r[k] != null) return r[k];
      return null;
    };
    out.push({
      metricDate: date,
      readinessScore: (pick("readinessScore") as number | null) ?? null,
      sleepMinutes: (pick("sleepMinutes") as number | null) ?? null,
      sleepScore: (pick("sleepScore") as number | null) ?? null,
      hrvMs: pick("hrvMs") != null ? Number(pick("hrvMs")) : null,
      restingHr: (pick("restingHr") as number | null) ?? null,
      steps: (pick("steps") as number | null) ?? null,
      sources: dayRows.map(r => r.source),
    });
  }
  return out.sort((a, b) => (a.metricDate < b.metricDate ? 1 : -1));
}

export type ReadinessLevel = "full" | "conservative" | "rest";

export interface ReadinessRecommendation {
  level: ReadinessLevel;
  label: string;
  detail: string;
  score: number | null;
}

/**
 * Convert a readiness score (0–100) and sleep duration (minutes) into a
 * coaching recommendation for the pre-round screen. Falls back gracefully
 * when only one signal is available.
 */
export function computeReadinessRecommendation(
  readinessScore: number | null,
  sleepMinutes: number | null,
): ReadinessRecommendation {
  let score: number | null = readinessScore;
  if (score == null && sleepMinutes != null) {
    // Crude fallback: 8h sleep ≈ 80, 6h ≈ 50, 4h ≈ 25
    score = Math.max(0, Math.min(100, Math.round((sleepMinutes / 60) * 10)));
  }

  if (score == null) {
    return {
      level: "full",
      label: "No readiness data yet",
      detail: "Connect Whoop, Garmin, Apple Health, or Google Fit to see a personalised pre-round recommendation.",
      score: null,
    };
  }
  if (score >= 67) {
    return { level: "full", label: "Play with full intensity", detail: "Your recovery is strong — go after pins and trust your aggressive lines.", score };
  }
  if (score >= 34) {
    return { level: "conservative", label: "Play conservatively", detail: "Recovery is moderate. Favour fairways and centres of greens; pick smarter clubs into long approaches.", score };
  }
  return { level: "rest", label: "Consider rest or a light range session", detail: "Your body is under-recovered. A full competitive round risks injury and erratic scores — consider rescheduling or limiting to 9 holes.", score };
}

// ── HR / stress samples ───────────────────────────────────────────────────────

export interface IngestHrSample {
  hrBpm: number;
  hrvMs?: number | null;
  stressScore?: number | null;
  recordedAt: string;            // ISO timestamp from the watch
  holeNumber?: number | null;
  shotNumber?: number | null;
  source?: string;               // apple_watch | wear_os | garmin | manual
}

export interface IngestHrContext {
  userId: number;
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  playerId?: number | null;
  round?: number;
}

/**
 * Read the user's HR-capture preference. Returns a row with safe defaults
 * (capture disabled) when the user has never opened the consent screen.
 */
export async function getUserHealthPrefs(userId: number) {
  const [row] = await db
    .select()
    .from(userHealthPrefsTable)
    .where(eq(userHealthPrefsTable.userId, userId));
  return row ?? {
    userId,
    hrCaptureEnabled: false,
    baselineHrBpm: null,
    wellnessTrailingWindow: null,
    consentedAt: null,
    updatedAt: new Date(),
  };
}

/** Upsert the HR-capture preference. Sets consentedAt the first time it flips on. */
export async function setUserHealthPrefs(
  userId: number,
  patch: { hrCaptureEnabled?: boolean; baselineHrBpm?: number | null },
) {
  const existing = await getUserHealthPrefs(userId);
  const enabling = patch.hrCaptureEnabled === true && !existing.hrCaptureEnabled;
  const next = {
    userId,
    hrCaptureEnabled: patch.hrCaptureEnabled ?? existing.hrCaptureEnabled,
    baselineHrBpm: patch.baselineHrBpm === undefined ? existing.baselineHrBpm : patch.baselineHrBpm,
    consentedAt: enabling ? new Date() : existing.consentedAt,
    updatedAt: new Date(),
  };
  await db
    .insert(userHealthPrefsTable)
    .values(next)
    .onConflictDoUpdate({
      target: userHealthPrefsTable.userId,
      set: {
        hrCaptureEnabled: next.hrCaptureEnabled,
        baselineHrBpm: next.baselineHrBpm,
        consentedAt: next.consentedAt,
        updatedAt: next.updatedAt,
      },
    });
  return next;
}

// ── Active HR-capture session tracking ─────────────────────────────────
//
// Task #717 / #874: when a player abandons a round (force-quit, OS jetsam,
// crash) the consent flag is still on, so the existing `no_consent` guard
// does not refuse stragglers from the watch. We track an in-memory "active
// HR session" per user that the phone opens via POST /portal/hr-samples/
// session (action="start") on hrStart and closes (action="end") on hrStop.
// The session is also kept alive by each successful sample POST, but only
// up to a TTL — so when the phone process dies and stops heart-beating,
// the session goes stale and subsequent POSTs are refused with
// `session_inactive` even though consent is still on.
//
// Task #1025: state lives in shared storage (Postgres `hr_active_sessions`
// table) keyed by userId with an `expiresAt` TTL column, instead of the
// previous in-memory per-process Map. That way a session opened on instance
// A is visible to instance B in a multi-instance deployment, so legitimate
// sample POSTs that hit a different instance than the one that received the
// /portal/hr-samples/session start are still accepted, and stragglers from
// abandoned rounds are still refused once the TTL elapses on every instance.

const HR_SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes — long enough for normal play, short enough to bound battery drain after abandon

// Background sweep cadence (Task #1194). Stale rows are normally removed
// lazily: `isHrSessionActive` deletes the row when it observes an expired
// TTL, and `markHrSessionEnded` is called on every clean hrStop. Rows for
// users who never POST again (rare — hard crash with no follow-up traffic)
// would otherwise stick around until the next time someone checks that
// user. The cron in `lib/cron.ts` calls `sweepStaleHrSessions` once per
// hour to drop any row whose `expires_at` is older than the grace
// threshold below. The grace window is intentionally much larger than the
// TTL itself so the sweep can never race with `refreshHrSessionIfActive`
// (a long DB stall + clock skew on a busy node).
const HR_SESSION_SWEEP_GRACE_MS = 60 * 60 * 1000; // 1 hour — only sweep rows that have been expired for at least this long
export const HR_SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Open or refresh the active HR-capture session for a user. */
export async function markHrSessionActive(userId: number): Promise<void> {
  const expiresAt = new Date(Date.now() + HR_SESSION_TTL_MS);
  await db.insert(hrActiveSessionsTable)
    .values({ userId, expiresAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: hrActiveSessionsTable.userId,
      set: { expiresAt, updatedAt: new Date() },
    });
}

/** Close the active HR-capture session for a user (e.g. on hrStop). */
export async function markHrSessionEnded(userId: number): Promise<void> {
  await db.delete(hrActiveSessionsTable).where(eq(hrActiveSessionsTable.userId, userId));
}

/** Returns true iff the user currently has an active, unexpired HR session. */
export async function isHrSessionActive(userId: number): Promise<boolean> {
  const rows = await db
    .select({ expiresAt: hrActiveSessionsTable.expiresAt })
    .from(hrActiveSessionsTable)
    .where(eq(hrActiveSessionsTable.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (row.expiresAt.getTime() <= Date.now()) {
    // Best-effort cleanup of the stale row.
    await db.delete(hrActiveSessionsTable).where(eq(hrActiveSessionsTable.userId, userId));
    return false;
  }
  return true;
}

/**
 * Atomically refresh the active HR-capture session for a user iff a row
 * already exists and has not yet expired. Returns true when the row was
 * refreshed, false when no active session exists. Used by the ingest path
 * so that a concurrent `markHrSessionEnded` (e.g. an `action="end"` POST
 * arriving between the check and the refresh) cannot be undone — we never
 * resurrect a stopped session, we only extend an active one.
 */
export async function refreshHrSessionIfActive(userId: number): Promise<boolean> {
  const newExpiresAt = new Date(Date.now() + HR_SESSION_TTL_MS);
  const updated = await db
    .update(hrActiveSessionsTable)
    .set({ expiresAt: newExpiresAt, updatedAt: new Date() })
    .where(and(
      eq(hrActiveSessionsTable.userId, userId),
      gte(hrActiveSessionsTable.expiresAt, new Date()),
    ))
    .returning({ userId: hrActiveSessionsTable.userId });
  return updated.length > 0;
}

/**
 * Test-only helper: force the user's HR session to expire immediately, as if
 * the TTL had elapsed. Used to simulate the phone process dying without
 * having to wait the real {@link HR_SESSION_TTL_MS}.
 */
export async function _forceExpireHrSessionForTest(userId: number): Promise<void> {
  await db.delete(hrActiveSessionsTable).where(eq(hrActiveSessionsTable.userId, userId));
}

/**
 * Sweep long-expired rows out of `hr_active_sessions` (Task #1194).
 *
 * The lazy cleanup paths (`isHrSessionActive`, `markHrSessionEnded`) only
 * touch a row when somebody specifically references that user. Rows for
 * users who never POST again (e.g. hard crash with no follow-up traffic)
 * accumulate without that prompt. This sweep is the safety net: it drops
 * any row whose `expires_at` is older than {@link HR_SESSION_SWEEP_GRACE_MS}.
 *
 * Returns the number of rows deleted (useful for logging / tests).
 *
 * Idempotent and concurrency-safe: only rows already past the TTL by a
 * full grace window are touched, so it cannot race with
 * `refreshHrSessionIfActive` or `markHrSessionActive`.
 */
export async function sweepStaleHrSessions(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HR_SESSION_SWEEP_GRACE_MS);
  const deleted = await db
    .delete(hrActiveSessionsTable)
    .where(lt(hrActiveSessionsTable.expiresAt, cutoff))
    .returning({ userId: hrActiveSessionsTable.userId });
  return deleted.length;
}

/**
 * Ingest a batch of HR samples. The opt-in flag is checked first — when the
 * player has not consented (or has revoked consent) we silently drop the batch
 * to "fail safe" rather than store sensitive health data. We then check the
 * active-session guard so stragglers from an abandoned round are also refused
 * even when consent is still on (Task #874).
 *
 * Returns the number of samples actually persisted.
 */
export async function ingestHrSamples(
  ctx: IngestHrContext,
  samples: IngestHrSample[],
): Promise<{ inserted: number; rejected: "no_consent" | "session_inactive" | "empty" | null }> {
  if (!samples.length) return { inserted: 0, rejected: "empty" };
  const prefs = await getUserHealthPrefs(ctx.userId);
  if (!prefs.hrCaptureEnabled) return { inserted: 0, rejected: "no_consent" };
  // Active-session guard (Task #717 / #874). The phone opens an HR session
  // alongside hrStart and closes it on hrStop; samples that arrive without
  // an active, unexpired session are stragglers from an abandoned round
  // (force-quit, OS jetsam, crash) and must be refused even though
  // consent is still on — otherwise the watch can keep posting for
  // minutes after the player has clearly walked away.
  // Atomic check-and-refresh: a single conditional UPDATE that only
  // bumps the TTL when an unexpired row exists. Doing this in one
  // statement (instead of read-then-upsert) means a concurrent
  // `markHrSessionEnded` arriving between the two awaits cannot be
  // accidentally undone — we never resurrect a stopped session, we
  // only extend an already-active one.
  if (!(await refreshHrSessionIfActive(ctx.userId))) {
    return { inserted: 0, rejected: "session_inactive" };
  }

  const rows = samples
    .filter(s => Number.isFinite(s.hrBpm) && s.hrBpm > 0 && s.hrBpm < 240 && !!s.recordedAt)
    .map(s => ({
      userId: ctx.userId,
      tournamentId: ctx.tournamentId ?? null,
      generalPlayRoundId: ctx.generalPlayRoundId ?? null,
      playerId: ctx.playerId ?? null,
      round: ctx.round ?? 1,
      holeNumber: s.holeNumber ?? null,
      shotNumber: s.shotNumber ?? null,
      hrBpm: Math.round(s.hrBpm),
      hrvMs: s.hrvMs != null ? String(s.hrvMs) : null,
      stressScore: s.stressScore != null ? Math.round(s.stressScore) : null,
      source: s.source ?? "apple_watch",
      recordedAt: new Date(s.recordedAt),
    }));

  if (!rows.length) return { inserted: 0, rejected: "empty" };
  await db.insert(hrSamplesTable).values(rows);
  return { inserted: rows.length, rejected: null };
}

export interface PerHoleHrPoint {
  holeNumber: number;
  count: number;
  avgHr: number;
  maxHr: number;
  avgStress: number | null;
}

export interface PerShotHrPoint {
  shotNumber: number;
  hrBpm: number | null;
  stressScore: number | null;
  recordedAt: string;
}

/**
 * Per-hole HR strip + per-shot waveform for a single round (tournament or
 * general-play). Used by the after-hole strip on the score screen and the
 * full-round heat-strip on the stats screen.
 */
export async function getRoundHrStrip(args: {
  userId: number;
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  round?: number;
}): Promise<{
  holes: PerHoleHrPoint[];
  shots: { holeNumber: number; shots: PerShotHrPoint[] }[];
  baselineHrBpm: number | null;
}> {
  const round = args.round ?? 1;
  const conds = [eq(hrSamplesTable.userId, args.userId), eq(hrSamplesTable.round, round)];
  if (args.tournamentId) conds.push(eq(hrSamplesTable.tournamentId, args.tournamentId));
  if (args.generalPlayRoundId) conds.push(eq(hrSamplesTable.generalPlayRoundId, args.generalPlayRoundId));

  const samples = await db
    .select()
    .from(hrSamplesTable)
    .where(and(...conds))
    .orderBy(asc(hrSamplesTable.holeNumber), asc(hrSamplesTable.shotNumber), asc(hrSamplesTable.recordedAt));

  const byHole = new Map<number, typeof samples>();
  for (const s of samples) {
    if (s.holeNumber == null) continue;
    const arr = byHole.get(s.holeNumber) ?? [];
    arr.push(s);
    byHole.set(s.holeNumber, arr);
  }

  const holes: PerHoleHrPoint[] = [];
  const shots: { holeNumber: number; shots: PerShotHrPoint[] }[] = [];
  for (const [holeNumber, list] of [...byHole.entries()].sort((a, b) => a[0] - b[0])) {
    const hrs = list.map(s => s.hrBpm);
    const stresses = list.map(s => s.stressScore).filter((v): v is number => v != null);
    holes.push({
      holeNumber,
      count: list.length,
      avgHr: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length),
      maxHr: Math.max(...hrs),
      avgStress: stresses.length ? Math.round(stresses.reduce((a, b) => a + b, 0) / stresses.length) : null,
    });
    shots.push({
      holeNumber,
      shots: list.map(s => ({
        shotNumber: s.shotNumber ?? 0,
        hrBpm: s.hrBpm,
        stressScore: s.stressScore,
        recordedAt: s.recordedAt.toISOString(),
      })),
    });
  }

  const prefs = await getUserHealthPrefs(args.userId);
  return { holes, shots, baselineHrBpm: prefs.baselineHrBpm ?? null };
}

/**
 * Correlation widget: bogey-or-worse rate when HR is elevated above the
 * player's baseline by `thresholdBpm` (default 15 bpm). Returns sample
 * counts so the UI can show "low data" disclaimers when the sample size
 * is too small to be meaningful.
 */
export async function getHrScoringCorrelation(args: {
  userId: number;
  thresholdBpm?: number;
}): Promise<{
  baselineHrBpm: number | null;
  thresholdBpm: number;
  elevatedHoles: number;
  elevatedBogeyOrWorse: number;
  elevatedBogeyRate: number | null;
  normalHoles: number;
  normalBogeyOrWorse: number;
  normalBogeyRate: number | null;
  totalHolesWithHr: number;
}> {
  const threshold = args.thresholdBpm ?? 15;
  const prefs = await getUserHealthPrefs(args.userId);
  const baseline = prefs.baselineHrBpm ?? null;

  // Aggregate average HR per (tournamentId, round, holeNumber) for the user.
  const perHole = await db
    .select({
      tournamentId: hrSamplesTable.tournamentId,
      playerId: hrSamplesTable.playerId,
      round: hrSamplesTable.round,
      holeNumber: hrSamplesTable.holeNumber,
      avgHr: sql<number>`avg(${hrSamplesTable.hrBpm})::int`,
    })
    .from(hrSamplesTable)
    .where(and(eq(hrSamplesTable.userId, args.userId), isNotNull(hrSamplesTable.holeNumber), isNotNull(hrSamplesTable.tournamentId)))
    .groupBy(hrSamplesTable.tournamentId, hrSamplesTable.playerId, hrSamplesTable.round, hrSamplesTable.holeNumber);

  if (!perHole.length || baseline == null) {
    return {
      baselineHrBpm: baseline,
      thresholdBpm: threshold,
      elevatedHoles: 0, elevatedBogeyOrWorse: 0, elevatedBogeyRate: null,
      normalHoles: 0, normalBogeyOrWorse: 0, normalBogeyRate: null,
      totalHolesWithHr: perHole.length,
    };
  }

  // Look up scores+par for each (tournament/player/round/hole).
  let elevatedHoles = 0, elevatedBogey = 0, normalHoles = 0, normalBogey = 0;

  for (const row of perHole) {
    if (!row.tournamentId || !row.playerId || row.holeNumber == null) continue;
    const [score] = await db
      .select({ strokes: scoresTable.strokes })
      .from(scoresTable)
      .where(and(
        eq(scoresTable.tournamentId, row.tournamentId),
        eq(scoresTable.playerId, row.playerId),
        eq(scoresTable.round, row.round),
        eq(scoresTable.holeNumber, row.holeNumber),
      ));
    if (!score || score.strokes == null) continue;
    // Look up par from holeDetails — joined via the player's tournament course.
    const [holeRow] = await db
      .select({ par: holeDetailsTable.par })
      .from(holeDetailsTable)
      .where(eq(holeDetailsTable.holeNumber, row.holeNumber))
      .limit(1);
    const par = holeRow?.par ?? 4;
    const overPar = score.strokes - par >= 1;
    if (row.avgHr - baseline >= threshold) {
      elevatedHoles++;
      if (overPar) elevatedBogey++;
    } else {
      normalHoles++;
      if (overPar) normalBogey++;
    }
  }

  return {
    baselineHrBpm: baseline,
    thresholdBpm: threshold,
    elevatedHoles,
    elevatedBogeyOrWorse: elevatedBogey,
    elevatedBogeyRate: elevatedHoles ? elevatedBogey / elevatedHoles : null,
    normalHoles,
    normalBogeyOrWorse: normalBogey,
    normalBogeyRate: normalHoles ? normalBogey / normalHoles : null,
    totalHolesWithHr: perHole.length,
  };
}

/** Delete all HR samples (and revoke the consent flag) for the user. */
export async function listHrSampleRoundsForUser(userId: number): Promise<{ tournamentId: number | null; generalPlayRoundId: number | null; round: number; lastSampleAt: string }[]> {
  const rows = await db.select({
    tournamentId: hrSamplesTable.tournamentId,
    generalPlayRoundId: hrSamplesTable.generalPlayRoundId,
    round: hrSamplesTable.round,
    lastSampleAt: sql<string>`max(${hrSamplesTable.recordedAt})`.as("last_sample_at"),
  })
    .from(hrSamplesTable)
    .where(eq(hrSamplesTable.userId, userId))
    .groupBy(hrSamplesTable.tournamentId, hrSamplesTable.generalPlayRoundId, hrSamplesTable.round)
    .orderBy(desc(sql`max(${hrSamplesTable.recordedAt})`));
  return rows.map(r => ({
    tournamentId: r.tournamentId,
    generalPlayRoundId: r.generalPlayRoundId,
    round: r.round,
    lastSampleAt: typeof r.lastSampleAt === "string" ? r.lastSampleAt : new Date(r.lastSampleAt as unknown as number).toISOString(),
  }));
}

export async function deleteAllHrSamplesForUser(userId: number): Promise<{ deleted: number }> {
  const result = await db.delete(hrSamplesTable)
    .where(eq(hrSamplesTable.userId, userId))
    .returning({ id: hrSamplesTable.id });
  await setUserHealthPrefs(userId, { hrCaptureEnabled: false });
  return { deleted: result.length };
}

// Suppress unused-import warnings on optional helpers
void desc; void gte;
