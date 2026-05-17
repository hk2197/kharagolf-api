/**
 * Auto shot-detection pipeline.
 *
 * Combines three independent signal streams into a single proposed shot list:
 *   1. Phone GPS samples           — high-confidence "stationary → moving"
 *      transitions reliably mark walking-to-position pauses between shots.
 *   2. Watch motion events         — accelerometer peaks indicate a swing.
 *   3. Existing wearable shot rows — Garmin/Arccos pre-detected shots.
 *
 * The output is an ordered list of inferred shots with hole/shot numbers
 * already assigned via the standard nearest-green heuristic. Sensitivity is
 * tunable on three axes:
 *   - `gpsStationaryRadiusM`:     how tightly the player must be standing
 *                                  still before we register a "shot stop".
 *   - `gpsStationarySeconds`:     how long they must remain inside that
 *                                  radius before we open a shot window.
 *   - `motionPeakG`:              minimum accel magnitude to count as a swing.
 *
 * Reference tuning: Arccos uses roughly 0.4 g threshold + 8m GPS radius +
 * 4s pause; Shot Scope X5 uses roughly 0.6 g + 6m + 3s. Our medium preset
 * splits the difference; users can pick low/medium/high at the API layer.
 *
 * Detected shots are returned as-is (not persisted). Callers decide whether
 * to insert into `shotsTable` after optional human review.
 */

import { db, gpsChunkBufferTable, holeDetailsTable, shotsTable, watchMotionBufferTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export interface GPSSample {
  lat: number;
  lng: number;
  timestamp: number; // ms since epoch
  accuracy?: number | null; // metres
}

export interface MotionEvent {
  timestamp: number; // ms since epoch
  peakG: number;     // accelerometer magnitude in g
}

export interface DetectionSensitivity {
  gpsStationaryRadiusM: number;
  gpsStationarySeconds: number;
  motionPeakG: number;
  maxShotsPerHole: number;
}

/**
 * Per-user buffer of accelerometer-peak events streamed from a paired watch
 * (Apple Watch / Wear OS / Garmin). Watches POST motion peaks to
 * `/api/portal/watch/motion` while a round is in progress; the phone then
 * drains them when it calls `/api/portal/shots/detect` at hole/round boundary.
 *
 * Persisted in Postgres (`watch_motion_buffer`) so the buffer survives API
 * server restarts (deploys, autoscale events) mid-round — Task #527.
 *
 * Buffered events older than `MOTION_BUFFER_TTL_MS` are pruned on every
 * push/drain so a player who never finishes a round cannot grow the table
 * unbounded.
 */
const MOTION_BUFFER_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Per-user safety cap to stop a misbehaving watch from filling storage.
const MOTION_BUFFER_MAX_PER_USER = 5000;

// Internal helper — delete rows older than the TTL for a single user.
async function _pruneExpired(userId: number): Promise<void> {
  const cutoffMs = Date.now() - MOTION_BUFFER_TTL_MS;
  await db.delete(watchMotionBufferTable).where(
    and(
      eq(watchMotionBufferTable.userId, userId),
      lte(watchMotionBufferTable.eventTimestampMs, String(cutoffMs)),
    ),
  );
}

// Enforce the per-user cap by deleting the oldest rows beyond MAX.
async function _enforceCap(userId: number): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(watchMotionBufferTable)
    .where(eq(watchMotionBufferTable.userId, userId));
  if (count <= MOTION_BUFFER_MAX_PER_USER) return count;
  // Drop the oldest (smallest event_timestamp_ms) rows until we are at the cap.
  await db.execute(sql`
    DELETE FROM ${watchMotionBufferTable}
    WHERE id IN (
      SELECT id FROM ${watchMotionBufferTable}
      WHERE user_id = ${userId}
      ORDER BY event_timestamp_ms ASC
      LIMIT ${count - MOTION_BUFFER_MAX_PER_USER}
    )
  `);
  return MOTION_BUFFER_MAX_PER_USER;
}

export async function bufferMotionEvents(userId: number, events: MotionEvent[]): Promise<number> {
  await _pruneExpired(userId);
  const cutoff = Date.now() - MOTION_BUFFER_TTL_MS;
  const valid = events.filter(
    e => typeof e.timestamp === "number" && typeof e.peakG === "number" && e.timestamp >= cutoff,
  );
  if (valid.length > 0) {
    await db.insert(watchMotionBufferTable).values(
      valid.map(e => ({
        userId,
        eventTimestampMs: String(Math.trunc(e.timestamp)),
        peakG: String(e.peakG),
      })),
    );
  }
  return _enforceCap(userId);
}

async function _selectBufferedRange(userId: number, fromMs?: number, toMs?: number): Promise<MotionEvent[]> {
  const conds = [eq(watchMotionBufferTable.userId, userId)];
  if (typeof fromMs === "number" && Number.isFinite(fromMs)) {
    conds.push(gte(watchMotionBufferTable.eventTimestampMs, String(Math.trunc(fromMs))));
  }
  if (typeof toMs === "number" && Number.isFinite(toMs)) {
    conds.push(lte(watchMotionBufferTable.eventTimestampMs, String(Math.trunc(toMs))));
  }
  const rows = await db
    .select({
      eventTimestampMs: watchMotionBufferTable.eventTimestampMs,
      peakG: watchMotionBufferTable.peakG,
    })
    .from(watchMotionBufferTable)
    .where(and(...conds));
  return rows.map(r => ({ timestamp: Number(r.eventTimestampMs), peakG: Number(r.peakG) }));
}

/**
 * Pull buffered motion events for a user, optionally restricted to a time
 * window. Drained events are removed from the buffer to avoid double-counting
 * across consecutive detect calls (e.g. once per hole).
 *
 * Implemented as a single `DELETE ... RETURNING` so concurrent inserts from
 * /watch/motion can never lose events between the read and the delete.
 */
export async function drainMotionEvents(userId: number, fromMs?: number, toMs?: number): Promise<MotionEvent[]> {
  await _pruneExpired(userId);
  const conds = [eq(watchMotionBufferTable.userId, userId)];
  if (typeof fromMs === "number" && Number.isFinite(fromMs)) {
    conds.push(gte(watchMotionBufferTable.eventTimestampMs, String(Math.trunc(fromMs))));
  }
  if (typeof toMs === "number" && Number.isFinite(toMs)) {
    conds.push(lte(watchMotionBufferTable.eventTimestampMs, String(Math.trunc(toMs))));
  }
  const rows = await db
    .delete(watchMotionBufferTable)
    .where(and(...conds))
    .returning({
      eventTimestampMs: watchMotionBufferTable.eventTimestampMs,
      peakG: watchMotionBufferTable.peakG,
    });
  return rows.map(r => ({ timestamp: Number(r.eventTimestampMs), peakG: Number(r.peakG) }));
}

/**
 * Read buffered motion events without removing them. Use this for review-only
 * (commit:false) detection so a subsequent commit detect call sees the same
 * watch motion and produces the same proposals the user just approved.
 */
export async function peekMotionEvents(userId: number, fromMs?: number, toMs?: number): Promise<MotionEvent[]> {
  await _pruneExpired(userId);
  return _selectBufferedRange(userId, fromMs, toMs);
}

/**
 * Durable per-(user,round) buffer of GPS samples streamed from the phone
 * **during** a round. Historically the phone held every sample in memory and
 * POSTed them once at round-end; that single fat request was fragile (one
 * dropped network call lost detection for the whole round) and gave the
 * player no incremental "X shots detected so far" feedback.
 *
 * The phone now POSTs small chunks every few minutes / on hole change to
 * `/portal/shots/ingest`, which calls {@link bufferGPSSamples} below. Chunks
 * are merged idempotently — duplicate samples (same timestamp) are dropped,
 * so the same chunk can be retried after a network failure without
 * producing duplicate proposals at round-end.
 *
 * The `contextKey` namespaces buffers per round (e.g. `t:42:r:1` for
 * tournament 42 round 1, `g:99:r:1` for general-play round 99) so a player
 * with two concurrent rounds (rare, but possible across tournaments) does
 * not cross-contaminate samples between them.
 *
 * Persisted in Postgres (`gps_chunk_buffer`) so chunks survive an api-server
 * restart (deploys, autoscale, crash) mid-round and the round-end commit
 * detect call still has the full sample set — Task #690. Idempotency is
 * enforced by a unique index on (user_id, context_key, sample_timestamp_ms);
 * retried chunks rely on ON CONFLICT DO NOTHING so the same chunk replayed
 * after a network blip contributes zero new rows.
 */
const GPS_BUFFER_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours — covers a long round + delay
const GPS_BUFFER_MAX = 20_000; // ~28 h at 5 s cadence; hard cap against runaway clients

// Internal helper — delete rows older than the TTL for a single (user,context).
async function _pruneExpiredGps(userId: number, contextKey: string): Promise<void> {
  const cutoffMs = Date.now() - GPS_BUFFER_TTL_MS;
  await db.delete(gpsChunkBufferTable).where(
    and(
      eq(gpsChunkBufferTable.userId, userId),
      eq(gpsChunkBufferTable.contextKey, contextKey),
      lte(gpsChunkBufferTable.sampleTimestampMs, String(cutoffMs)),
    ),
  );
}

// Global prune — deletes expired rows across *all* (user,context) pairs so
// rounds that the player abandoned (and never touches again) are eventually
// purged. Without this, the per-context prune above would leak rows for any
// abandoned round forever.
//
// Throttled to at most once per `_GLOBAL_PRUNE_INTERVAL_MS` per process so a
// busy ingest endpoint doesn't run the same DELETE on every request. The
// prune is opportunistic: any ingest/detect call may pay the cost, but never
// more than one in a six-minute window. A real cron sweep is a follow-up.
const _GLOBAL_PRUNE_INTERVAL_MS = 6 * 60 * 1000;
let _lastGlobalPruneAt = 0;
async function _maybeGlobalPruneExpiredGps(): Promise<void> {
  const now = Date.now();
  if (now - _lastGlobalPruneAt < _GLOBAL_PRUNE_INTERVAL_MS) return;
  _lastGlobalPruneAt = now;
  const cutoffMs = now - GPS_BUFFER_TTL_MS;
  await db.delete(gpsChunkBufferTable).where(
    lte(gpsChunkBufferTable.sampleTimestampMs, String(cutoffMs)),
  );
}

/**
 * Test/cron hook: force the global prune to run on the next call by
 * resetting the throttle window. Exported so a periodic sweep job can
 * invoke a guaranteed prune and so tests can deterministically exercise
 * the global cleanup path.
 */
export async function pruneExpiredGpsBuffersGlobal(): Promise<void> {
  _lastGlobalPruneAt = 0;
  await _maybeGlobalPruneExpiredGps();
}

// Enforce the per-(user,context) cap by deleting the oldest rows beyond MAX.
async function _enforceGpsCap(userId: number, contextKey: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gpsChunkBufferTable)
    .where(and(
      eq(gpsChunkBufferTable.userId, userId),
      eq(gpsChunkBufferTable.contextKey, contextKey),
    ));
  if (count <= GPS_BUFFER_MAX) return count;
  await db.execute(sql`
    DELETE FROM ${gpsChunkBufferTable}
    WHERE id IN (
      SELECT id FROM ${gpsChunkBufferTable}
      WHERE user_id = ${userId} AND context_key = ${contextKey}
      ORDER BY sample_timestamp_ms ASC
      LIMIT ${count - GPS_BUFFER_MAX}
    )
  `);
  return GPS_BUFFER_MAX;
}

async function _selectGpsBuffered(userId: number, contextKey: string): Promise<GPSSample[]> {
  const rows = await db
    .select({
      sampleTimestampMs: gpsChunkBufferTable.sampleTimestampMs,
      lat: gpsChunkBufferTable.lat,
      lng: gpsChunkBufferTable.lng,
      accuracyM: gpsChunkBufferTable.accuracyM,
    })
    .from(gpsChunkBufferTable)
    .where(and(
      eq(gpsChunkBufferTable.userId, userId),
      eq(gpsChunkBufferTable.contextKey, contextKey),
    ));
  return rows
    .map(r => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      timestamp: Number(r.sampleTimestampMs),
      accuracy: r.accuracyM === null || r.accuracyM === undefined ? null : Number(r.accuracyM),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merge a chunk of GPS samples into the per-(user,round) buffer. Returns
 * the deduped, time-sorted buffer length so callers can surface a "running
 * sample count" to the UI.
 *
 * Idempotency is enforced by the (user_id, context_key, sample_timestamp_ms)
 * unique index: a chunk replayed after a network retry contributes zero new
 * rows and the buffer is unchanged.
 */
export async function bufferGPSSamples(
  userId: number,
  contextKey: string,
  samples: GPSSample[],
): Promise<number> {
  await _pruneExpiredGps(userId, contextKey);
  // Opportunistic global prune so abandoned (user,context) pairs eventually
  // get reaped even when their owning round is never touched again.
  await _maybeGlobalPruneExpiredGps();
  const cutoff = Date.now() - GPS_BUFFER_TTL_MS;
  // Local dedupe so a single chunk that itself contains repeated timestamps
  // doesn't blow up the multi-row INSERT (Postgres errors on duplicate keys
  // within the same statement even with ON CONFLICT).
  const seen = new Set<number>();
  const valid: { ts: number; lat: number; lng: number; accuracy: number | null }[] = [];
  for (const s of samples) {
    if (typeof s?.timestamp !== "number" || !Number.isFinite(s.timestamp)) continue;
    if (typeof s?.lat !== "number" || typeof s?.lng !== "number") continue;
    if (s.timestamp < cutoff) continue;
    const ts = Math.trunc(s.timestamp);
    if (seen.has(ts)) continue;
    seen.add(ts);
    valid.push({
      ts, lat: s.lat, lng: s.lng,
      accuracy: s.accuracy === undefined || s.accuracy === null ? null : s.accuracy,
    });
  }
  if (valid.length > 0) {
    await db.insert(gpsChunkBufferTable).values(
      valid.map(v => ({
        userId,
        contextKey,
        sampleTimestampMs: String(v.ts),
        lat: String(v.lat),
        lng: String(v.lng),
        accuracyM: v.accuracy === null ? null : String(v.accuracy),
      })),
    ).onConflictDoNothing({
      target: [
        gpsChunkBufferTable.userId,
        gpsChunkBufferTable.contextKey,
        gpsChunkBufferTable.sampleTimestampMs,
      ],
    });
  }
  return _enforceGpsCap(userId, contextKey);
}

/** Read buffered GPS samples without removing them. */
export async function peekGPSSamples(userId: number, contextKey: string): Promise<GPSSample[]> {
  await _pruneExpiredGps(userId, contextKey);
  await _maybeGlobalPruneExpiredGps();
  return _selectGpsBuffered(userId, contextKey);
}

/** Drop the buffered GPS samples for a (user,round) pair — call on commit. */
export async function clearGPSSamples(userId: number, contextKey: string): Promise<void> {
  await db.delete(gpsChunkBufferTable).where(and(
    eq(gpsChunkBufferTable.userId, userId),
    eq(gpsChunkBufferTable.contextKey, contextKey),
  ));
}

/**
 * Merge a request-supplied GPS array with whatever was previously chunked
 * for the same (user,round). Dedupes by timestamp so a client that resends
 * its full local buffer at round-end does not double-count earlier chunks.
 */
export async function mergeBufferedGPS(
  userId: number,
  contextKey: string,
  requestGps: GPSSample[],
): Promise<GPSSample[]> {
  const buffered = await peekGPSSamples(userId, contextKey);
  if (buffered.length === 0) return [...requestGps].sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  const merged: GPSSample[] = [];
  for (const s of buffered) {
    if (seen.has(s.timestamp)) continue;
    seen.add(s.timestamp);
    merged.push(s);
  }
  for (const s of requestGps) {
    if (typeof s?.timestamp !== "number" || !Number.isFinite(s.timestamp)) continue;
    if (seen.has(s.timestamp)) continue;
    seen.add(s.timestamp);
    merged.push(s);
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

export const SENSITIVITY_PRESETS: Record<"low" | "medium" | "high", DetectionSensitivity> = {
  low:    { gpsStationaryRadiusM: 12, gpsStationarySeconds: 6, motionPeakG: 0.7, maxShotsPerHole: 12 },
  medium: { gpsStationaryRadiusM: 8,  gpsStationarySeconds: 4, motionPeakG: 0.5, maxShotsPerHole: 14 },
  high:   { gpsStationaryRadiusM: 5,  gpsStationarySeconds: 3, motionPeakG: 0.4, maxShotsPerHole: 18 },
};

export type DetectedShotType = "tee" | "fairway" | "approach" | "chip" | "sand" | "putt";
const VALID_SHOT_TYPES: ReadonlySet<DetectedShotType> =
  new Set(["tee", "fairway", "approach", "chip", "sand", "putt"]);

export interface DetectedShot {
  holeNumber: number;
  shotNumber: number;
  shotType: DetectedShotType;
  /** Whether shotType came from a wearable's pre-classification (true) or
   *  was inferred from distance heuristics (false). Surfaces in API output
   *  so clients/UI can flag low-trust inferences for user review. */
  shotTypeFromWearable?: boolean;
  club?: string | null;
  latitude: number;
  longitude: number;
  distanceToPinYards: number;
  recordedAt: Date;
  source: "gps" | "motion" | "wearable" | "fused";
  confidence: number; // 0..1
}

const R_EARTH = 6371000;
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function metersToYards(m: number): number { return m * 1.09361; }

/**
 * Identify GPS "stop points": clusters of samples within `radiusM` lasting
 * at least `minSeconds`. Each stop is a candidate shot location (the player
 * paused to play). Returns the median sample of each cluster.
 */
function findGPSStops(samples: GPSSample[], sens: DetectionSensitivity): GPSSample[] {
  if (samples.length < 2) return [];
  const stops: GPSSample[] = [];
  let i = 0;
  while (i < samples.length) {
    const anchor = samples[i];
    let j = i + 1;
    while (j < samples.length) {
      const d = haversineMeters(anchor.lat, anchor.lng, samples[j].lat, samples[j].lng);
      if (d > sens.gpsStationaryRadiusM) break;
      j++;
    }
    const elapsed = (samples[j - 1].timestamp - anchor.timestamp) / 1000;
    if (elapsed >= sens.gpsStationarySeconds) {
      const mid = samples[Math.floor((i + j - 1) / 2)];
      stops.push(mid);
    }
    i = Math.max(j, i + 1);
  }
  return stops;
}

/**
 * Filter motion events to peaks above the configured g-force threshold.
 * Adjacent peaks within 1.5s are coalesced (a single swing produces several
 * accelerometer spikes from the takeaway, transition, and impact).
 */
function findSwingPeaks(events: MotionEvent[], sens: DetectionSensitivity): MotionEvent[] {
  if (events.length === 0) return [];
  const peaks: MotionEvent[] = [];
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  let last = -Infinity;
  for (const e of sorted) {
    if (e.peakG < sens.motionPeakG) continue;
    if (e.timestamp - last < 1500) continue;
    peaks.push(e);
    last = e.timestamp;
  }
  return peaks;
}

interface HoleGreen { holeNumber: number; lat: number; lng: number; }

async function loadGreens(courseId: number): Promise<HoleGreen[]> {
  const rows = await db
    .select({
      holeNumber: holeDetailsTable.holeNumber,
      greenCentreLat: holeDetailsTable.greenCentreLat,
      greenCentreLng: holeDetailsTable.greenCentreLng,
    })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId));
  return rows
    .filter(r => r.greenCentreLat !== null && r.greenCentreLng !== null)
    .map(r => ({
      holeNumber: r.holeNumber,
      lat: parseFloat(r.greenCentreLat!),
      lng: parseFloat(r.greenCentreLng!),
    }))
    .sort((a, b) => a.holeNumber - b.holeNumber);
}

function inferShotType(
  shotIdxInHole: number,
  distToGreenM: number,
): DetectedShot["shotType"] {
  if (shotIdxInHole === 0) return "tee";
  if (distToGreenM < 10) return "putt";
  if (distToGreenM < 30) return "chip";
  if (distToGreenM < 150) return "approach";
  return "fairway";
}

/**
 * Fuse GPS stops + motion peaks + wearable shots into a single shot timeline,
 * then assign each event to a hole using nearest-green progression.
 *
 * Priority order when events overlap (within 8 seconds):
 *   1. wearable shot row    (Garmin/Arccos already classified — highest trust)
 *   2. motion peak          (definitive swing, but no location data alone)
 *   3. GPS stop             (location-only; weakest in isolation)
 *
 * A motion peak that occurs within the time window of a GPS stop is "fused":
 * we use the GPS coordinates (location confirmed) plus the motion timestamp.
 */
export async function detectShotsFromSignals(opts: {
  courseId: number;
  gps: GPSSample[];
  motion: MotionEvent[];
  wearableShots?: Array<{ lat: number; lng: number; timestamp: number; shotType?: string | null; club?: string | null }>;
  sensitivity?: DetectionSensitivity;
}): Promise<DetectedShot[]> {
  const sens = opts.sensitivity ?? SENSITIVITY_PRESETS.medium;
  const greens = await loadGreens(opts.courseId);
  if (greens.length === 0) return [];

  const stops = findGPSStops(opts.gps, sens);
  const peaks = findSwingPeaks(opts.motion, sens);
  const wearable = opts.wearableShots ?? [];

  // Build a fused candidate list keyed by timestamp. Wearable candidates may
  // carry a pre-classified shotType / club from the device (e.g. Garmin tagged
  // it as "putt with putter"); those are preserved end-to-end so SG category
  // splits and analytics reflect the trusted classification rather than a
  // distance-only heuristic.
  type Candidate = {
    ts: number;
    lat: number;
    lng: number;
    source: DetectedShot["source"];
    confidence: number;
    shotType?: DetectedShotType;
    club?: string | null;
  };
  const candidates: Candidate[] = [];

  // Deterministic precedence: wearable > motion (fused with GPS) > GPS-only.
  // We dedupe greedily — once a higher-precedence candidate is recorded for a
  // time slot, lower-precedence signals within DEDUPE_WINDOW_MS are dropped so
  // a single real swing does not produce 2-3 inferred shots when sources overlap.
  const DEDUPE_WINDOW_MS = 8_000;
  const isDuplicate = (ts: number) =>
    candidates.some(c => Math.abs(c.ts - ts) < DEDUPE_WINDOW_MS);

  // 1. Wearable shots — highest confidence, never deduped against each other
  //    (trusted source already classified the swing). Preserve the device-
  //    provided shotType (when it matches our enum) and club name so the
  //    downstream SG/analytics pipeline can rely on them instead of a
  //    distance-only inference.
  for (const w of wearable) {
    const wsType = w.shotType && VALID_SHOT_TYPES.has(w.shotType as DetectedShotType)
      ? (w.shotType as DetectedShotType)
      : undefined;
    candidates.push({
      ts: w.timestamp, lat: w.lat, lng: w.lng,
      source: "wearable", confidence: 0.95,
      shotType: wsType,
      club: w.club ?? null,
    });
  }

  // 2. Motion peaks — fuse with nearest GPS stop (within ±8 s) for location.
  //    Skip peaks already covered by a wearable shot.
  const usedStopIdx = new Set<number>();
  for (const peak of peaks) {
    if (isDuplicate(peak.timestamp)) continue; // covered by wearable
    let best = -1, bestDt = DEDUPE_WINDOW_MS;
    for (let i = 0; i < stops.length; i++) {
      if (usedStopIdx.has(i)) continue;
      const dt = Math.abs(stops[i].timestamp - peak.timestamp);
      if (dt < bestDt) { bestDt = dt; best = i; }
    }
    if (best >= 0) {
      usedStopIdx.add(best);
      const s = stops[best];
      candidates.push({ ts: peak.timestamp, lat: s.lat, lng: s.lng, source: "fused", confidence: 0.9 });
    } else {
      // Motion peak with no nearby GPS stop — back-fill location from the
      // nearest GPS sample (within 30 s) at lower confidence.
      let nearest = opts.gps[0];
      let nearestDt = nearest ? Math.abs(nearest.timestamp - peak.timestamp) : Infinity;
      for (const g of opts.gps) {
        const dt = Math.abs(g.timestamp - peak.timestamp);
        if (dt < nearestDt) { nearestDt = dt; nearest = g; }
      }
      if (nearest && nearestDt < 30_000) {
        candidates.push({ ts: peak.timestamp, lat: nearest.lat, lng: nearest.lng, source: "motion", confidence: 0.6 });
      }
    }
  }

  // 3. Remaining GPS stops — only counted when neither wearable nor motion
  //    already explains the time slot. This prevents a single swing recorded
  //    by both phone GPS and watch motion from producing two shots.
  for (let i = 0; i < stops.length; i++) {
    if (usedStopIdx.has(i)) continue;
    const s = stops[i];
    if (isDuplicate(s.timestamp)) continue;
    candidates.push({ ts: s.timestamp, lat: s.lat, lng: s.lng, source: "gps", confidence: 0.55 });
  }

  candidates.sort((a, b) => a.ts - b.ts);

  // Assign each candidate to a hole. We do NOT advance simply because the
  // player is on/near a green — that would misclassify multi-putt holes by
  // pushing the second putt onto the next hole. Instead we advance only when
  // a candidate is unambiguously closer to the *next* green than the current
  // one, which is the natural signature of having walked off to the next tee.
  // A maxShotsPerHole safety valve still prevents runaway assignment.
  const out: DetectedShot[] = [];
  let greenIdx = 0;
  let shotInHole = 0;
  for (const c of candidates) {
    if (greenIdx >= greens.length) break;
    const green = greens[greenIdx];
    const distM = haversineMeters(c.lat, c.lng, green.lat, green.lng);
    const nextGreen = greens[greenIdx + 1];
    const distNextM = nextGreen
      ? haversineMeters(c.lat, c.lng, nextGreen.lat, nextGreen.lng)
      : Infinity;

    // Forward progression: this candidate sits closer to the next green than
    // the current one — player has moved on. Only honour it once at least one
    // shot has been logged for the current hole, otherwise we would skip
    // holes when the very first candidate arrives mid-fairway.
    if (shotInHole > 0 && distNextM + 5 < distM) {
      greenIdx++;
      shotInHole = 0;
      if (greenIdx >= greens.length) break;
      // Re-evaluate against the new current hole below.
      const ng = greens[greenIdx];
      const newDistM = haversineMeters(c.lat, c.lng, ng.lat, ng.lng);
      out.push({
        holeNumber: ng.holeNumber,
        shotNumber: 1,
        shotType: c.shotType ?? inferShotType(0, newDistM),
        shotTypeFromWearable: c.shotType !== undefined,
        club: c.club ?? null,
        latitude: c.lat,
        longitude: c.lng,
        distanceToPinYards: Math.round(metersToYards(newDistM) * 10) / 10,
        recordedAt: new Date(c.ts),
        source: c.source,
        confidence: c.confidence,
      });
      shotInHole = 1;
      continue;
    }

    if (shotInHole >= sens.maxShotsPerHole) {
      // Hole appears stuck — force progression to avoid runaway lists.
      greenIdx++;
      shotInHole = 0;
      if (greenIdx >= greens.length) break;
      continue;
    }

    out.push({
      holeNumber: green.holeNumber,
      shotNumber: shotInHole + 1,
      shotType: c.shotType ?? inferShotType(shotInHole, distM),
      shotTypeFromWearable: c.shotType !== undefined,
      club: c.club ?? null,
      latitude: c.lat,
      longitude: c.lng,
      distanceToPinYards: Math.round(metersToYards(distM) * 10) / 10,
      recordedAt: new Date(c.ts),
      source: c.source,
      confidence: c.confidence,
    });
    shotInHole++;
  }

  return out;
}

/**
 * Convert detected shots into the wire format used by `shotsTable` inserts.
 * Centralised here so callers don't have to know about numeric→string casts.
 */
export function detectedShotsToInsert(
  shots: DetectedShot[],
  ctx: { tournamentId?: number | null; generalPlayRoundId?: number | null; playerId?: number | null; userId?: number | null; round: number },
): Array<typeof shotsTable.$inferInsert> {
  return shots.map<typeof shotsTable.$inferInsert>(s => ({
    tournamentId: ctx.tournamentId ?? null,
    generalPlayRoundId: ctx.generalPlayRoundId ?? null,
    playerId: ctx.playerId ?? null,
    userId: ctx.userId ?? null,
    round: ctx.round,
    holeNumber: s.holeNumber,
    shotNumber: s.shotNumber,
    shotType: s.shotType as typeof shotsTable.$inferInsert.shotType,
    club: s.club ?? null,
    latitude: String(s.latitude),
    longitude: String(s.longitude),
    distanceToPin: String(s.distanceToPinYards),
    // Task #547 — bucket the detected shot's signal source down to the
    // user-visible source enum: anything carrying a wearable signal counts
    // as "watch", everything else (raw GPS / motion-only) is "phone".
    source: (s.source === "wearable" || s.source === "fused") ? "watch" : "phone",
    recordedAt: s.recordedAt,
  }));
}
